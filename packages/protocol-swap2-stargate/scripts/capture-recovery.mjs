// Historical receipts/state only. No signer, transaction submission, or private credentials.
import {writeFile, rename} from "node:fs/promises";
import {createHash} from "node:crypto";
import {decodeFunctionData, decodeFunctionResult, encodeFunctionData, encodePacked, keccak256, pad, parseEventLogs, slice} from "viem";
import {builtinNetwork} from "@anywalletkit/networks";
import {ENDPOINT_ABI, EXECUTOR_ABI, STARGATE_ABI} from "../dist/abi.js";
import {stargateRegistry} from "../dist/deployments.js";
import {checkStargateReceipt, stargateTaxiProof, stargateTaxiPayout} from "../dist/tracking.js";
import {STARGATE_TAXI_EXECUTORS, stargateTaxiNativeDrop} from "../dist/native-drop.js";
import {destinationAmount} from "../dist/amounts.js";
import {context, stringify, EvidenceError} from "./evidence.mjs";

const assert = (v, code) => { if (!v) throw new EvidenceError(code); };
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const zero = `0x${"00".repeat(32)}`;
const upstreamCommit = "592625b9e5967643853476445ffe0e777360b906";
const contexts = new Map();
let stage = "initialization";
async function chain(d) {
  if (!contexts.has(d.chain)) contexts.set(d.chain, context(d.chain, d.chainId, process.env[`RPC_${d.chainId}`] ? [process.env[`RPC_${d.chainId}`]] : builtinNetwork(d.chain).rpcs.slice(0, 2)));
  return contexts.get(d.chain);
}
async function evidence(d, hash) {
  stage = `receipt:${d.chain}`;
  const ctx = await chain(d);
  const [receipt, tx] = await Promise.all([ctx.client.getTransactionReceipt({hash}), ctx.client.getTransaction({hash})]);
  const block = await ctx.client.getBlock({blockNumber: receipt.blockNumber});
  assert(receipt.status === "success" && block.hash && receipt.blockNumber <= ctx.block.number && tx.blockNumber === receipt.blockNumber && same(tx.blockHash, block.hash), "receipt-identity-or-finality");
  checkStargateReceipt(receipt, hash, block.hash);
  return {chain: d.chain, chainId: d.chainId, block: {number: block.number, hash: block.hash, timestamp: block.timestamp}, transaction: {hash, from: tx.from, to: tx.to, input: tx.input, value: tx.value}, receipt};
}
async function state(d, blockNumber, address, abi, functionName, args = []) {
  stage = `state:${d.chain}:${functionName}`;
  const ctx = await chain(d), data = encodeFunctionData({abi, functionName, args});
  const result = await ctx.client.call({to: address, data, blockNumber});
  assert(result.data, "missing-state-result");
  return {chain: d.chain, blockNumber, to: address, data, result: result.data, functionName, decoded: decodeFunctionResult({abi, functionName, data: result.data})};
}
async function capture() {
  const cases = [];
  const samples = [
    {kind: "cached-token-recovery", guid: "0xed0750234d6aed19536b44cee2b63b8dbd14434dc95c958364d0157146dbed30", recoveryHash: "0xd3c10e97d4c8f783995bd2d133e44dcbc2da44cc6258dc4c8ed198d1f30d40a4", nativeDrop: 0n},
    {kind: "taxi-native-drop", guid: "0x550b7ca548f909ce9b42fae05b20012e5427b427c74b2b24a3ceacd1ce689b2a", nativeDrop: 50_000_000_000_000n},
  ];
  for (const sample of samples) {
    const url = `https://scan.layerzero-api.com/v1/messages/guid/${sample.guid}`;
    const response = await fetch(url, {signal: AbortSignal.timeout(20_000)});
    assert(response.ok, "scan-unavailable");
    const message = (await response.json()).data?.find((m) => same(m.guid, sample.guid));
    assert(message && /^0x01[0-9a-f]{84}$/i.test(message.source?.tx?.payload), "not-plain-taxi");
    const assetId = parseInt(slice(message.source.tx.payload, 1, 3).slice(2), 16);
    const src = stargateRegistry.deployments.find((d) => d.eid === message.pathway.srcEid && d.assetId === assetId);
    const dst = stargateRegistry.deployments.find((d) => d.eid === message.pathway.dstEid && d.assetId === assetId);
    assert(src && dst && stargateRegistry.route(src.chain, src.token, dst.chain, dst.token), "unreviewed-route");
    const source = await evidence(src, message.source.tx.txHash), destination = await evidence(dst, message.destination.tx.txHash);
    const sent = parseEventLogs({abi: STARGATE_ABI, eventName: "OFTSent", logs: source.receipt.logs.filter((l) => same(l.address, src.address)), strict: true}).find((l) => same(l.args.guid, sample.guid));
    assert(sent, "missing-source-event");
    const intent = {source: src, destination: dst, mode: "taxi", sender: sent.args.fromAddress, recipient: slice(message.source.tx.payload, 15, 35), amount: sent.args.amountSentLD, minimum: destinationAmount(sent.args.amountReceivedLD, src.localDecimals, dst.localDecimals, src.sharedDecimals), nativeDrop: sample.nativeDrop};
    const proof = stargateTaxiProof(intent, source.receipt);
    const entry = {kind: sample.kind, guid: sample.guid, assetId, discovery: {url}, intent, source, destination};
    if (sample.recoveryHash) {
      const cached = parseEventLogs({abi: STARGATE_ABI, eventName: "UnreceivedTokenCached", logs: destination.receipt.logs.filter((l) => same(l.address, dst.address)), strict: true}).filter((l) => same(l.args.guid, proof.guid));
      assert(cached.length === 1 && cached[0].args.index === 0 && cached[0].args.amountLD === proof.amount && same(cached[0].args.receiver, intent.recipient) && !stargateTaxiPayout(proof, destination.receipt), "cache-event-mismatch");
      const recovery = await evidence(dst, sample.recoveryHash);
      assert(recovery.block.number > destination.block.number && stargateTaxiPayout(proof, recovery.receipt), "missing-later-recovery-payout");
      const decoded = decodeFunctionData({abi: STARGATE_ABI, data: recovery.transaction.input});
      assert(same(recovery.transaction.to, dst.address) && decoded.functionName === "retryReceiveToken", "unexpected-recovery-call");
      const expectedData = encodeFunctionData({abi: STARGATE_ABI, functionName: "retryReceiveToken", args: [proof.guid, 0, src.eid, intent.recipient, proof.amount, "0x"]});
      assert(same(expectedData, recovery.transaction.input) && recovery.transaction.value === 0n, "recovery-calldata-mismatch");
      const before = await state(dst, destination.block.number, dst.address, STARGATE_ABI, "unreceivedTokens", [proof.guid, 0]);
      const after = await state(dst, recovery.block.number, dst.address, STARGATE_ABI, "unreceivedTokens", [proof.guid, 0]);
      const expected = keccak256(encodePacked(["uint32", "address", "uint256", "bytes"], [src.eid, intent.recipient, proof.amount, "0x"]));
      assert(before.decoded === expected && after.decoded === zero, "cache-state-transition-mismatch");
      const status = await state(dst, destination.block.number, dst.address, STARGATE_ABI, "status");
      const payload = await state(dst, recovery.block.number, dst.endpoint, ENDPOINT_ABI, "inboundPayloadHash", [dst.tokenMessaging, src.eid, pad(src.tokenMessaging, {size: 32}), proof.nonce]);
      entry.recovery = recovery; entry.calls = [before, after, status, payload];
    } else {
      assert(stargateTaxiPayout(proof, destination.receipt), "missing-token-payout");
      const drop = await evidence(dst, message.destination.nativeDrop.tx.txHash);
      const executors = STARGATE_TAXI_EXECUTORS[dst.chain] ?? [];
      assert(stargateTaxiNativeDrop(proof, drop.receipt, executors), "missing-native-drop-payout");
      const executor = executors[0];
      const metadataUrl = "https://metadata.layerzero-api.com/v1/metadata/deployments";
      const metadataResponse = await fetch(metadataUrl, {signal: AbortSignal.timeout(20_000)});
      assert(metadataResponse.ok, "metadata-unavailable");
      stage = "executor-metadata";
      const metadataRaw = await metadataResponse.text(), metadata = Object.values(JSON.parse(metadataRaw)).find((m) => m.chainDetails?.nativeChainId === dst.chainId && m.deployments?.some((d) => d.version === 2 && d.stage === "mainnet"));
      assert(metadata, "executor-chain-metadata-missing");
      const deployment = metadata.deployments.find((d) => d.version === 2);
      assert(metadata.chainDetails.nativeChainId === dst.chainId && same(deployment.executor.address, executor) && deployment.eid === String(dst.eid), "executor-metadata-mismatch");
      const calls = [await state(dst, drop.block.number, executor, EXECUTOR_ABI, "endpoint"), await state(dst, drop.block.number, executor, EXECUTOR_ABI, "localEid")];
      assert(same(calls[0].decoded, dst.endpoint) && calls[1].decoded === dst.eid, "executor-chain-identity-mismatch");
      const code = await (await chain(dst)).client.getCode({address: executor, blockNumber: drop.block.number});
      assert(code && code !== "0x", "executor-has-no-code");
      const upstream = [];
      for (const path of ["Executor.sol", "interfaces/IExecutor.sol"]) {
        const sourceUrl = `https://raw.githubusercontent.com/LayerZero-Labs/LayerZero-v2/${upstreamCommit}/packages/layerzero-v2/evm/messagelib/contracts/${path}`;
        const r = await fetch(sourceUrl, {signal: AbortSignal.timeout(20_000)}); assert(r.ok, "upstream-unavailable");
        upstream.push({path, url: sourceUrl, sha256: sha256(await r.text())});
      }
      entry.drop = drop; entry.calls = calls;
      entry.executorEvidence = {executor, codeHash: keccak256(code), metadata: {url: metadataUrl, sha256: sha256(metadataRaw), deployment}, upstreamCommit, upstream};
    }
    for (const side of [source, destination, entry.recovery, entry.drop].filter(Boolean)) {
      const d = side.chain === src.chain ? src : dst;
      assert(same((await (await chain(d)).client.getBlock({blockNumber: side.block.number})).hash, side.block.hash), "block-changed");
    }
    cases.push(entry);
    console.log(`${sample.kind}: verified historical receipts and on-chain state`);
  }
  const file = new URL("../tests/fixtures/recovery.json", import.meta.url), tmp = new URL("../tests/fixtures/recovery.json.tmp", import.meta.url);
  await writeFile(tmp, stringify({schemaVersion: 1, kind: "historical-mainnet-recovery-evidence", capturedAt: new Date().toISOString(), cases}));
  await rename(tmp, file);
}
try { await capture(); } catch (error) {
  console.error(`Recovery capture failed at ${stage}: ${error instanceof EvidenceError ? error.code : "RPC/API/validation error"}. Previous snapshot preserved.`);
  process.exitCode = 1;
}
