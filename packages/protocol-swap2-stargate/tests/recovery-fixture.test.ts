import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {encodeAbiParameters, getAbiItem, parseEventLogs, toHex, type Hex, type TransactionReceipt} from "viem";
import {EXECUTOR_ABI} from "../src/abi.js";
import {stargateRegistry} from "../src/deployments.js";
import {parseStargateIntent} from "../src/intent.js";
import {STARGATE_TAXI_EXECUTORS, stargateTaxiNativeDrop} from "../src/native-drop.js";
import {checkStargateReceipt, createStargateTracker, stargateTaxiProof} from "../src/tracking.js";

type Side = {chain: string; chainId: number; block: {number: string; hash: Hex; timestamp: string}; transaction: {hash: Hex; from: Hex; to: Hex; input: Hex; value: string}; receipt: {transactionHash: Hex; status: string; blockNumber: string; blockHash: Hex; logs: Array<Record<string, unknown>>}};
type Sample = {kind: string; guid: Hex; assetId: number; intent: {sender: Hex; recipient: Hex; amount: string; minimum: string; nativeDrop: string}; source: Side; destination: Side; recovery?: Side; drop?: Side; calls: {chain: string; blockNumber: string; to: Hex; data: Hex; result: Hex; functionName: string; decoded: unknown}[]; executorEvidence?: {executor: Hex; upstreamCommit: string; metadata: {deployment: {executor: {address: Hex}}}}};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/recovery.json", import.meta.url), "utf8")) as {kind: string; cases: Sample[]};
const ZERO = `0x${"00".repeat(32)}` as Hex;
function receipt(side: Side): TransactionReceipt {
  return {...side.receipt, blockNumber: BigInt(side.receipt.blockNumber), logs: side.receipt.logs.map((l) => ({...l, blockNumber: BigInt(String(l.blockNumber))}))} as unknown as TransactionReceipt;
}
function sample(c: Sample) {
  const src = stargateRegistry.deployments.find((d) => d.chain === c.source.chain && d.assetId === c.assetId)!;
  const dst = stargateRegistry.deployments.find((d) => d.chain === c.destination.chain && d.assetId === c.assetId)!;
  const intentId = ["stargate", 1, src.eid, dst.eid, c.assetId, "taxi", c.intent.sender.toLowerCase(), c.intent.recipient.toLowerCase(), c.intent.amount, c.intent.minimum, c.intent.nativeDrop].join(":");
  return {intentId, intent: parseStargateIntent(intentId, stargateRegistry), ref: {intentId, sourceTxHash: c.source.transaction.hash}};
}
function server(c: Sample) {
  const s = sample(c);
  const state = {recovered: false, destination: receipt(c.destination), drop: receipt(c.drop ?? c.destination), separateDrop: false, dropIndexed: true};
  const separateHash = `0x${"ab".repeat(32)}` as Hex;
  const sides = [c.source, c.destination, c.recovery, c.drop].filter((v): v is Side => !!v);
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://scan.test")) return Response.json({data: [{guid: c.guid, status: {name: "DELIVERED"}, destination: {tx: {txHash: c.destination.transaction.hash}, ...(c.drop && state.dropIndexed ? {nativeDrop: {status: "SUCCEEDED", tx: {txHash: state.separateDrop ? separateHash : c.drop.transaction.hash}}} : {})}}]});
    const request = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
    const chain = String(url).includes("source.test") ? c.source.chain : c.destination.chain;
    const head = chain === c.source.chain ? c.source : state.recovered && c.recovery ? c.recovery : c.destination;
    let result: unknown;
    if (request.method === "eth_chainId") result = toHex(head.chainId);
    else if (request.method === "eth_getBlockByNumber") {
      const final = request.params[0] === "finalized";
      const side = final ? head : sides.find((v) => v.chain === chain && BigInt(v.block.number) === BigInt(String(request.params[0])));
      if (!side) throw new Error("Unexpected block");
      result = {number: toHex(BigInt(side.block.number) + (final ? 1n : 0n)), hash: side.block.hash, timestamp: toHex(BigInt(side.block.timestamp)), transactions: []};
    } else if (request.method === "eth_getTransactionReceipt") {
      const hash = request.params[0];
      const side = sides.find((v) => v.chain === chain && v.transaction.hash === hash);
      const value = hash === separateHash ? state.drop : hash === c.destination.transaction.hash ? state.destination : side ? receipt(side) : undefined;
      if (!value || (hash === c.recovery?.transaction.hash && !state.recovered)) return Response.json({jsonrpc: "2.0", id: request.id, result: null});
      result = {...value, status: value.status === "success" ? "0x1" : "0x0", blockNumber: toHex(value.blockNumber), logs: value.logs.map((l) => ({...l, blockNumber: toHex(l.blockNumber!), logIndex: toHex(l.logIndex!), transactionIndex: toHex(l.transactionIndex!)}))};
    } else if (request.method === "eth_call") {
      const call = request.params[0] as {to: Hex; data: Hex};
      const matching = c.calls.filter((v) => v.chain === chain && v.to.toLowerCase() === call.to.toLowerCase() && v.data === call.data);
      if (!matching.length) throw new Error("Unexpected contract read");
      result = (state.recovered ? matching.at(-1) : matching[0])!.result;
    } else throw new Error(`Unexpected RPC ${request.method}`);
    return Response.json({jsonrpc: "2.0", id: request.id, result});
  };
  const config = {rpcUrls: {[c.source.chain]: "https://source.test", [c.destination.chain]: "https://destination.test"}, fetchImpl, scanUrl: "https://scan.test"};
  return {...s, state, config, separateHash, tracker: createStargateTracker(config)};
}

describe("historical recovery and Taxi gas drop", () => {
  it("proves cached → recovered with actual commitment reads and exact retry calldata", async () => {
    const c = fixture.cases[0]!, s = server(c);
    expect(fixture.kind).toBe("historical-mainnet-recovery-evidence");
    for (const side of [c.source, c.destination, c.recovery!]) checkStargateReceipt(receipt(side), side.transaction.hash, side.receipt.blockHash);
    const calls = c.calls.filter((r) => r.functionName === "unreceivedTokens");
    expect(calls[0]!.result).not.toBe(ZERO);
    expect(calls[1]!.result).toBe(ZERO);
    // Scan says DELIVERED even though the destination token is still cached.
    expect(await s.tracker.trackIntent(s.ref)).toEqual({state: "action-required", depositReceived: true});
    const [q] = await s.tracker.getRecoveryQuotes(s.ref);
    expect(q).toMatchObject({kind: "retry-token", tx: {to: s.intent.destination.address, data: c.recovery!.transaction.input, value: "0"}});
    expect(await s.tracker.verifyRecovery(s.ref, q!, c.recovery!.transaction.from)).toBeNull();
    s.state.recovered = true;
    expect(await s.tracker.verifyRecovery(s.ref, q!, c.recovery!.transaction.from)).not.toBeNull();
    expect(await s.tracker.getRecoveryQuotes(s.ref)).toEqual([]);
    expect(await s.tracker.trackIntent({...s.ref, recoveryChain: c.recovery!.chain, recoveryTxHash: c.recovery!.transaction.hash})).toEqual({state: "completed", depositReceived: true, destTxHash: c.recovery!.transaction.hash});
  });

  it("proves the actual Base Taxi token payout and native drop separately", async () => {
    const c = fixture.cases[1]!, s = server(c);
    const proof = stargateTaxiProof(s.intent, receipt(c.source));
    expect(c.executorEvidence!.upstreamCommit).toBe("592625b9e5967643853476445ffe0e777360b906");
    expect(c.executorEvidence!.metadata.deployment.executor.address.toLowerCase()).toBe(STARGATE_TAXI_EXECUTORS[c.destination.chain]![0]);
    expect(stargateTaxiNativeDrop(proof, receipt(c.drop!), STARGATE_TAXI_EXECUTORS[c.destination.chain]!)).toBe(true);
    expect(await s.tracker.trackIntent(s.ref)).toEqual({state: "completed", depositReceived: true, destTxHash: c.destination.transaction.hash});
    expect((await createStargateTracker({...s.config, taxiExecutors: {}}).trackIntent(s.ref)).state).toBe("partial");
  });

  it("does not trust Scan success or a wrong executor, pathway, nonce, receiver, amount or success flag", async () => {
    const c = fixture.cases[1]!, s = server(c), base = receipt(c.drop!);
    const event = parseEventLogs({abi: EXECUTOR_ABI, eventName: "NativeDropApplied", logs: base.logs, strict: true})[0]!;
    const abiEvent = getAbiItem({abi: EXECUTOR_ABI, name: "NativeDropApplied"});
    const replace = (args: typeof event.args) => ({...base, logs: base.logs.map((l) => l.logIndex === event.logIndex ? {...l, data: encodeAbiParameters(abiEvent.inputs, [args.origin, args.dstEid, args.oapp, args.params, args.success])} : l)});
    for (const args of [
      {...event.args, origin: {...event.args.origin, nonce: event.args.origin.nonce + 1n}},
      {...event.args, dstEid: 30101},
      {...event.args, oapp: c.intent.recipient},
      {...event.args, params: [{...event.args.params[0]!, receiver: "0x1111111111111111111111111111111111111111" as Hex}]},
      {...event.args, params: [{...event.args.params[0]!, amount: 1n}]},
      {...event.args, success: [false]},
      {...event.args, success: []},
    ]) {
      s.state.destination = replace(args);
      expect((await s.tracker.trackIntent(s.ref)).state).toBe("partial");
    }
    s.state.destination = {...base, logs: base.logs.map((l) => l.logIndex === event.logIndex ? {...l, address: c.intent.recipient} : l)};
    expect((await s.tracker.trackIntent(s.ref)).state).toBe("partial");
  });

  it("combines separate drop and payout receipts only after authenticating both (mutated split)", async () => {
    const c = fixture.cases[1]!, s = server(c), base = receipt(c.drop!);
    const dropIndexes = parseEventLogs({abi: EXECUTOR_ABI, eventName: "NativeDropApplied", logs: base.logs}).map((l) => l.logIndex);
    s.state.separateDrop = true;
    s.state.destination = {...base, logs: base.logs.filter((l) => !dropIndexes.includes(l.logIndex))};
    s.state.drop = {...base, transactionHash: s.separateHash, logs: base.logs.filter((l) => dropIndexes.includes(l.logIndex)).map((l) => ({...l, transactionHash: s.separateHash}))};
    expect((await s.tracker.trackIntent(s.ref)).state).toBe("completed");
    s.state.dropIndexed = false;
    expect((await s.tracker.trackIntent(s.ref)).state).toBe("partial");
  });
});
