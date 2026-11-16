// Read-only historical evidence: Scan discovers transactions; chain receipts establish delivery.
import {writeFile, rename} from "node:fs/promises";
import {parseEventLogs, parseAbi, pad, slice} from "viem";
import {builtinNetwork} from "@anywalletkit/networks";
import {STARGATE_ABI} from "../dist/abi.js";
import {stargateRegistry} from "../dist/deployments.js";
import {destinationAmount} from "../dist/amounts.js";
import {context, stringify, EvidenceError} from "./evidence.mjs";

const samples = [
  ["native-pool-to-pool", "0xab0411a26a0bd77299fcad5a0a841400dceaa6046b3cfa4ce94545c65cdf960f"],
  ["erc20-pool-to-pool", "0x79e8ef50abbb047e1d70bf1df7ff961474c4c0333066adcbe07544c087435fc9"],
  ["local-decimals-18-to-6", "0xad528a10dbee581d320ad736ed22712b7d5940156c0b8ac96db8700be3c49a27"],
  ["hydra-oft-to-pool", "0x3906d721693c30cbac4b5ad44ce29d5e96bf7afde93bf36ab20f4f705fc3976e"],
  ["hydra-pool-to-oft", "0x07d34a1f22d6de96abd233af54fe4e02b43bf23c81ef0f785fb025a4ec3f723a"],
];
const endpointAbi = parseAbi(["event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)"]);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const assert = (ok, code) => { if (!ok) throw new EvidenceError(code); };

async function receiptEvidence(deployment, hash) {
  const {chain, chainId} = deployment;
  const urls = process.env[`RPC_${chainId}`] ? [process.env[`RPC_${chainId}`]] : builtinNetwork(chain).rpcs.slice(0, 2);
  const ctx = await context(chain, chainId, urls);
  const [receipt, tx] = await Promise.all([ctx.client.getTransactionReceipt({hash}), ctx.client.getTransaction({hash})]);
  assert(receipt.status === "success" && same(receipt.transactionHash, hash) && tx.blockNumber === receipt.blockNumber && same(tx.blockHash, receipt.blockHash), "receipt-identity-mismatch");
  assert(receipt.blockNumber <= ctx.block.number, "transaction-too-recent");
  const block = await ctx.client.getBlock({blockNumber: receipt.blockNumber});
  assert(same(block.hash, receipt.blockHash), "receipt-block-mismatch");
  for (const log of receipt.logs) assert(!log.removed && same(log.transactionHash, hash) && same(log.blockHash, receipt.blockHash), "log-identity-mismatch");
  return {
    client: ctx.client,
    evidence: {chain, chainId, block: {number: block.number, hash: block.hash, timestamp: block.timestamp},
      transaction: {hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, value: tx.value},
      receipt: {transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status, logs: receipt.logs}},
  };
}

async function capture() {
  const transfers = [];
  for (const [name, guid] of samples) {
    const url = `https://scan.layerzero-api.com/v1/messages/guid/${guid}`;
    const response = await fetch(url, {signal: AbortSignal.timeout(20_000)});
    assert(response.ok, "scan-unavailable");
    const body = await response.json();
    const message = body.data?.find((m) => same(m.guid, guid));
    assert(message?.status?.name === "DELIVERED", "scan-message-unavailable");
    const payload = message.source?.tx?.payload;
    assert(/^0x01[0-9a-f]{84}$/i.test(payload), "not-plain-taxi");
    const assetId = Number(BigInt(slice(payload, 1, 3)));
    const source = stargateRegistry.deployments.find((d) => d.eid === message.pathway.srcEid && d.assetId === assetId);
    const destination = stargateRegistry.deployments.find((d) => d.eid === message.pathway.dstEid && d.assetId === assetId);
    assert(source && destination && stargateRegistry.route(source.chain, source.token, destination.chain, destination.token), "unreviewed-route");
    const [src, dst] = await Promise.all([receiptEvidence(source, message.source.tx.txHash), receiptEvidence(destination, message.destination.tx.txHash)]);
    const sourceLogs = src.evidence.receipt.logs, destinationLogs = dst.evidence.receipt.logs;
    const sent = parseEventLogs({abi: STARGATE_ABI, eventName: "OFTSent", logs: sourceLogs.filter((l) => same(l.address, source.address)), strict: true}).filter((l) => same(l.args.guid, guid));
    const received = parseEventLogs({abi: STARGATE_ABI, eventName: "OFTReceived", logs: destinationLogs.filter((l) => same(l.address, destination.address)), strict: true}).filter((l) => same(l.args.guid, guid));
    assert(sent.length === 1 && received.length === 1, "missing-or-ambiguous-payout");
    const a = sent[0].args, b = received[0].args;
    assert(a.dstEid === destination.eid && b.srcEid === source.eid && same(pad(b.toAddress, {size: 32}), slice(payload, 3, 35)), "payout-path-or-recipient-mismatch");
    assert(destinationAmount(a.amountReceivedLD, source.localDecimals, destination.localDecimals, source.sharedDecimals) === b.amountReceivedLD, "payout-amount-mismatch");
    assert(BigInt(slice(payload, 35, 43)) * 10n ** BigInt(destination.localDecimals - destination.sharedDecimals) === b.amountReceivedLD, "payload-amount-mismatch");
    const packets = parseEventLogs({abi: endpointAbi, logs: sourceLogs.filter((l) => same(l.address, source.endpoint)), strict: true}).filter((l) => same(slice(l.args.encodedPayload, 81, 113), guid));
    assert(packets.length === 1, "missing-endpoint-packet");
    const packet = packets[0].args.encodedPayload;
    assert(slice(packet, 0, 1) === "0x01" && BigInt(slice(packet, 9, 13)) === BigInt(source.eid) && BigInt(slice(packet, 45, 49)) === BigInt(destination.eid), "packet-path-mismatch");
    assert(same(slice(packet, 13, 45), pad(source.tokenMessaging, {size: 32})) && same(slice(packet, 49, 81), pad(destination.tokenMessaging, {size: 32})) && same(slice(packet, 113), payload), "packet-message-mismatch");
    for (const side of [src, dst]) assert(same((await side.client.getBlock({blockNumber: side.evidence.block.number})).hash, side.evidence.block.hash), "block-changed");
    transfers.push({name, mode: "taxi", guid, assetId, sourceDeployment: source.address, destinationDeployment: destination.address, discovery: {url, status: message.status.name, payload}, source: src.evidence, destination: dst.evidence});
    console.log(`${name}: verified source packet + destination payout`);
  }
  const file = new URL("../tests/fixtures/receipts.json", import.meta.url), tmp = new URL("../tests/fixtures/receipts.json.tmp", import.meta.url);
  await writeFile(tmp, stringify({schemaVersion: 1, kind: "historical-mainnet-receipts", capturedAt: new Date().toISOString(), transfers}));
  await rename(tmp, file);
}
try { await capture(); } catch (error) {
  console.error(`Receipt capture failed: ${error instanceof EvidenceError ? error.code : "RPC/API/validation error"}. Previous snapshot preserved.`);
  process.exitCode = 1;
}
