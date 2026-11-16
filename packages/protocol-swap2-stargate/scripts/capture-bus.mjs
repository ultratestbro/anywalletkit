// Read-only historical Bus evidence. Scan finds the drive; receipts authenticate each rider and payout.
import {writeFile, rename} from "node:fs/promises";
import {parseEventLogs, slice, encodeFunctionData, decodeFunctionResult, encodePacked, keccak256, pad} from "viem";
import {builtinNetwork} from "@anywalletkit/networks";
import {ENDPOINT_ABI, STARGATE_ABI, TOKEN_MESSAGING_ABI} from "../dist/abi.js";
import {stargateRegistry} from "../dist/deployments.js";
import {destinationAmount} from "../dist/amounts.js";
import {stargateBusTicket, stargateBusProof, stargateBusPayout, stargateBusNativeDrop} from "../dist/bus.js";
import {checkStargateReceipt} from "../dist/tracking.js";
import {context, stringify, EvidenceError} from "./evidence.mjs";

const MANUAL_GUID = "0x8035e1da73782f22294f7759e1522f98b5f1190ced0400d548e64ba0508217b5";
const GUIDS = ["0x6b89bbfdfe8945badc273588d413a6488f3ae6a7d75ca402c537280298fdbfd1", "0xd4ef1d2b531961334427a7577ce5fbf6f776759fa548158d5b0d40cd7cc849b9", "0xa1d5f3b4efe3d1909faf138ffa583fceaaf6d802530a231d61e242425af20691", MANUAL_GUID];
const assert = (condition, code) => {if (!condition) throw new EvidenceError(code);};
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
let stage = "initialization";

async function capture() {
  const contexts = new Map();
  async function network(deployment) {
    stage = `network ${deployment.chain}`;
    let ctx = contexts.get(deployment.chain);
    if (!ctx) {
      const urls = process.env[`RPC_${deployment.chainId}`] ? [process.env[`RPC_${deployment.chainId}`]] : builtinNetwork(deployment.chain).rpcs.slice(0, 2);
      ctx = await context(deployment.chain, deployment.chainId, urls);
      contexts.set(deployment.chain, ctx);
    }
    return ctx;
  }
  async function evidence(deployment, hash) {
    const ctx = await network(deployment), c = ctx.client;
    stage = `receipt ${deployment.chain}`;
    const [receipt, tx] = await Promise.all([c.getTransactionReceipt({hash}), c.getTransaction({hash})]);
    stage = `historical block ${deployment.chain}`;
    const block = await c.getBlock({blockNumber: receipt.blockNumber});
    checkStargateReceipt(receipt, hash, block.hash);
    assert(receipt.status === "success" && tx.blockHash === receipt.blockHash && receipt.blockNumber <= ctx.block.number, "invalid-historical-receipt");
    return {chain: deployment.chain, chainId: deployment.chainId, block: {number: block.number, hash: block.hash, timestamp: block.timestamp}, transaction: {hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, value: tx.value}, receipt};
  }
  const buses = [];
  for (const guid of GUIDS) {
    const url = `https://scan.layerzero-api.com/v1/messages/guid/${guid}`;
    const response = await fetch(url, {signal: AbortSignal.timeout(20_000)});
    assert(response.ok, "scan-unavailable");
    const m = (await response.json()).data?.find((m) => same(m.guid, guid));
    assert(m?.source?.tx?.txHash && m?.destination?.tx?.txHash, "missing-bus-discovery");
    const src = stargateRegistry.deployments.find((d) => d.eid === m.pathway.srcEid);
    const dst = stargateRegistry.deployments.find((d) => d.eid === m.pathway.dstEid);
    assert(src && dst, "unreviewed-bus-chain");
    const [drive, destination] = await Promise.all([evidence(src, m.source.tx.txHash), evidence(dst, m.destination.tx.txHash)]);
    const driven = parseEventLogs({abi: TOKEN_MESSAGING_ABI, eventName: "BusDriven", logs: drive.receipt.logs.filter((l) => same(l.address, src.tokenMessaging)), strict: true}).filter((l) => same(l.args.guid, guid));
    assert(driven.length === 1, "ambiguous-drive");
    const {startTicketId, numPassengers, dstEid} = driven[0].args;
    const ctx = await network(src);
    stage = "BusRode log discovery";
    const logs = [];
    for (let page = 0; page < 8 && logs.length < numPassengers; page++) {
      const toBlock = drive.receipt.blockNumber - BigInt(page * 1000), fromBlock = toBlock > 999n ? toBlock - 999n : 0n;
      const rows = await ctx.client.getContractEvents({address: src.tokenMessaging, abi: TOKEN_MESSAGING_ABI, eventName: "BusRode", fromBlock, toBlock, strict: true});
      logs.push(...rows.filter((l) => l.args.dstEid === dstEid && l.args.ticketId >= startTicketId && l.args.ticketId < startTicketId + BigInt(numPassengers)));
    }
    assert(logs.length === numPassengers, "missing-rider-history");
    const riders = [];
    for (let seat = 0; seat < numPassengers; seat++) {
      const rode = logs.find((l) => l.args.ticketId === startTicketId + BigInt(seat));
      assert(rode, "missing-rider");
      const passenger = rode.args.passenger;
      const assetId = parseInt(slice(passenger, 0, 2).slice(2), 16);
      const sourcePool = stargateRegistry.deployments.find((d) => d.chain === src.chain && d.assetId === assetId);
      const destinationPool = stargateRegistry.deployments.find((d) => d.chain === dst.chain && d.assetId === assetId);
      assert(sourcePool && destinationPool, "unreviewed-passenger-asset");
      const source = await evidence(sourcePool, rode.transactionHash);
      const sent = parseEventLogs({abi: STARGATE_ABI, eventName: "OFTSent", logs: source.receipt.logs.filter((l) => same(l.address, sourcePool.address)), strict: true}).filter((l) => l.args.dstEid === dst.eid);
      assert(sent.length === 1, "ambiguous-rider-send");
      const a = sent[0].args;
      const intent = {source: sourcePool, destination: destinationPool, mode: "bus", sender: a.fromAddress, recipient: slice(passenger, 14, 34), amount: a.amountSentLD, minimum: destinationAmount(a.amountReceivedLD, sourcePool.localDecimals, destinationPool.localDecimals, sourcePool.sharedDecimals), nativeDrop: slice(passenger, 42, 43) === "0x01" ? BigInt(slice(m.source.tx.payload, 17, 33)) : 0n};
      stage = "passenger proof";
      const ticket = stargateBusTicket(intent, source.receipt), proof = stargateBusProof(ticket, drive.receipt);
      assert(proof.seat === seat && stargateBusPayout(proof, destination.receipt) === "paid", "bus-payout-proof-failed");
      if (intent.nativeDrop > 0n) assert(stargateBusNativeDrop(proof, destination.receipt), "bus-native-drop-proof-failed");
      riders.push({ticketId: ticket.ticketId, seat, assetId, intent, source});
    }
    let manualExecution;
    if (guid === MANUAL_GUID) {
      stage = "manual endpoint execution and historical payload commitment";
      const c = (await network(dst)).client;
      const before = await c.getBlock({blockNumber: destination.block.number - 1n});
      const rider = riders[0], proof = stargateBusProof(stargateBusTicket(rider.intent, rider.source.receipt), drive.receipt);
      const origin = {srcEid: src.eid, sender: pad(src.tokenMessaging, {size: 32}), nonce: proof.nonce};
      const data = encodeFunctionData({abi: ENDPOINT_ABI, functionName: "lzReceive", args: [origin, dst.tokenMessaging, guid, proof.message, "0x"]});
      assert(same(destination.transaction.to, dst.endpoint) && same(destination.transaction.input, data) && destination.transaction.value === proof.totalNativeDrops * proof.nativeDropAmount, "manual-execution-call-mismatch");
      const calls = [];
      async function read(address, abi, functionName, args, blockNumber) {
        const data = encodeFunctionData({abi, functionName, args});
        const result = await c.call({to: address, data, blockNumber});
        assert(result.data, "empty-historical-state");
        const decoded = decodeFunctionResult({abi, functionName, data: result.data});
        calls.push({chain: dst.chain, blockNumber, to: address, functionName, data, result: result.data, decoded});
        return decoded;
      }
      const payloadArgs = [dst.tokenMessaging, src.eid, origin.sender, proof.nonce];
      const expected = keccak256(encodePacked(["bytes32", "bytes"], [guid, proof.message]));
      assert(await read(dst.endpoint, ENDPOINT_ABI, "inboundPayloadHash", payloadArgs, before.number) === expected, "missing-before-execution-payload");
      assert(await read(dst.endpoint, ENDPOINT_ABI, "inboundPayloadHash", payloadArgs, destination.block.number) === `0x${"00".repeat(32)}`, "payload-not-cleared-after-execution");
      for (const r of riders) {
        assert(await read(r.intent.destination.address, STARGATE_ABI, "unreceivedTokens", [guid, r.seat], before.number) === `0x${"00".repeat(32)}`, "unexpected-token-cache-before-message");
      }
      for (const address of new Set(riders.map((r) => r.intent.destination.address))) assert(await read(address, STARGATE_ABI, "status", [], before.number) === 1, "pool-not-operational-before-message");
      assert((await c.getBlock({blockNumber: before.number})).hash === before.hash, "historical-before-block-changed");
      manualExecution = {beforeBlock: {number: before.number, hash: before.hash, timestamp: before.timestamp}, calls};
    }
    for (const side of [drive, destination, ...riders.map((r) => r.source)]) {
      assert((await contexts.get(side.chain).client.getBlock({blockNumber: side.block.number})).hash === side.block.hash, "historical-block-changed");
    }
    buses.push({guid, discovery: {url}, drive, destination, riders, ...(manualExecution ? {manualExecution} : {})});
    console.log(`Verified historical Bus with ${riders.length} riders: queue ticket -> drive packet -> each payout.`);
  }
  const file = new URL("../tests/fixtures/bus-receipts.json", import.meta.url), temp = new URL("../tests/fixtures/bus-receipts.json.tmp", import.meta.url);
  await writeFile(temp, stringify({schemaVersion: 1, kind: "historical-mainnet-bus-receipts", capturedAt: new Date().toISOString(), buses}));
  await rename(temp, file);
}
try { await capture(); } catch (error) {
  console.error(`Bus capture failed at ${stage}: ${error instanceof EvidenceError ? error.code : error?.name === "StargateReadError" ? error.message : "RPC/API/proof error (details omitted to protect credentials)"}. Previous snapshot preserved.`);
  process.exitCode = 1;
}
