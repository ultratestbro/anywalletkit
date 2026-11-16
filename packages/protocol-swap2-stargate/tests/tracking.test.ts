import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {decodeFunctionData, encodeFunctionResult, encodePacked, keccak256, parseEventLogs, slice, toHex, type Hex, type TransactionReceipt} from "viem";
import {ENDPOINT_ABI, STARGATE_ABI} from "../src/abi.js";
import {destinationAmount} from "../src/amounts.js";
import {stargateRegistry} from "../src/deployments.js";
import {parseStargateIntent} from "../src/intent.js";
import {checkStargateReceipt, createStargateTracker, stargateTaxiPayout, stargateTaxiProof} from "../src/tracking.js";

type Side = {chain: string; chainId: number; block: {number: string; hash: Hex; timestamp: string}; receipt: {transactionHash: Hex; status: string; blockNumber: string; blockHash: Hex; logs: Array<Record<string, unknown>>}};
type Transfer = {name: string; guid: Hex; assetId: number; discovery: {payload: Hex}; source: Side; destination: Side};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/receipts.json", import.meta.url), "utf8")) as {transfers: Transfer[]};
const zero = `0x${"00".repeat(32)}` as Hex;
const wrong = `0x${"ab".repeat(32)}` as Hex;
const actor = "0x1111111111111111111111111111111111111111";
function parsedReceipt(side: Side): TransactionReceipt {
  return {...side.receipt, blockNumber: BigInt(side.receipt.blockNumber), logs: side.receipt.logs.map((l) => ({...l, blockNumber: BigInt(String(l.blockNumber))}))} as unknown as TransactionReceipt;
}
function sample(t: Transfer) {
  const source = stargateRegistry.deployments.find((d) => d.chain === t.source.chain && d.assetId === t.assetId)!;
  const destination = stargateRegistry.deployments.find((d) => d.chain === t.destination.chain && d.assetId === t.assetId)!;
  const src = parsedReceipt(t.source), dst = parsedReceipt(t.destination);
  const a = parseEventLogs({abi: STARGATE_ABI, eventName: "OFTSent", logs: src.logs, strict: true}).find((l) => l.args.guid === t.guid)!.args;
  const recipient = slice(t.discovery.payload, 15, 35);
  const minimum = destinationAmount(a.amountReceivedLD, source.localDecimals, destination.localDecimals, source.sharedDecimals);
  const intentId = ["stargate", "1", source.eid, destination.eid, source.assetId, "taxi", a.fromAddress.toLowerCase(), recipient, a.amountSentLD, minimum, 0].join(":");
  const intent = parseStargateIntent(intentId, stargateRegistry);
  return {source, destination, src, dst, intent, intentId, ref: {intentId, sourceTxHash: src.transactionHash}};
}

function server(t: Transfer) {
  const s = sample(t);
  const proof = stargateTaxiProof(s.intent, s.src);
  const cache = keccak256(encodePacked(["uint32", "address", "uint256", "bytes"], [s.source.eid, s.intent.recipient, proof.amount, "0x"]));
  const payloadHash = keccak256(encodePacked(["bytes32", "bytes"], [proof.guid, proof.message]));
  const state = {source: s.src, destination: s.dst, cached: zero, payload: zero, paused: false, indexed: true, canonical: true, finalized: true, wrongChain: false, scanHash: s.dst.transactionHash};
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://scan.test/")) return Response.json({data: state.indexed ? [{guid: t.guid, status: {name: "DELIVERED"}, destination: {tx: {txHash: state.scanHash}}}] : []});
    const isSource = String(url).includes("source.test");
    const side = isSource ? t.source : t.destination;
    const receipt = isSource ? state.source : state.destination;
    const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
    let result: unknown;
    if (body.method === "eth_chainId") result = toHex(state.wrongChain ? 999 : side.chainId);
    else if (body.method === "eth_getBlockByNumber") result = {hash: state.canonical ? side.block.hash : wrong, number: toHex(BigInt(side.block.number) + (body.params[0] === "finalized" ? state.finalized ? 100n : -1n : 0n)), timestamp: toHex(BigInt(side.block.timestamp)), transactions: []};
    else if (body.method === "eth_getTransactionReceipt") result = {...receipt, status: receipt.status === "success" ? "0x1" : "0x0", blockNumber: toHex(receipt.blockNumber), logs: receipt.logs.map((l) => ({...l, blockNumber: toHex(l.blockNumber!)}))};
    else if (body.method === "eth_call") {
      const decoded = decodeFunctionData({abi: [...STARGATE_ABI, ...ENDPOINT_ABI], data: (body.params[0] as {data: Hex}).data});
      const value = decoded.functionName === "unreceivedTokens" ? state.cached : decoded.functionName === "inboundPayloadHash" ? state.payload : decoded.functionName === "status" ? state.paused ? 3 : 1 : undefined;
      if (value === undefined) throw new Error(`unexpected call ${decoded.functionName}`);
      result = encodeFunctionResult({abi: [...STARGATE_ABI, ...ENDPOINT_ABI], functionName: decoded.functionName, result: value});
    } else throw new Error(`unexpected RPC ${body.method}`);
    return Response.json({id: body.id, jsonrpc: "2.0", result});
  };
  const tracker = createStargateTracker({rpcUrls: {[s.source.chain]: "https://source.test", [s.destination.chain]: "https://destination.test"}, scanUrl: "https://scan.test", fetchImpl});
  return {...s, tracker, state, cache, payloadHash};
}

describe("runtime Taxi tracking replays real receipts", () => {
  for (const t of fixture.transfers) it(`${t.name}: proves payout from actual endpoint/pool logs`, async () => {
    const s = server(t);
    expect(await s.tracker.trackIntent(s.ref)).toEqual({state: "completed", depositReceived: true, destTxHash: s.dst.transactionHash});
    expect(await s.tracker.getRecoveryQuotes(s.ref)).toEqual([]);
  });

  it("does not trust Scan DELIVERED, a foreign destination transaction, or removed/failed payout logs", async () => {
    const t = fixture.transfers[0]!, s = server(t);
    s.state.scanHash = wrong;
    expect(await s.tracker.trackIntent(s.ref)).toEqual({state: "pending", depositReceived: true});
    s.state.scanHash = s.dst.transactionHash;
    s.state.destination = {...s.dst, status: "reverted"};
    expect((await s.tracker.trackIntent(s.ref)).state).toBe("pending");
    s.state.destination = {...s.dst, logs: s.dst.logs.map((l) => ({...l, removed: true}))};
    expect((await s.tracker.trackIntent(s.ref)).state).toBe("pending");
    s.state.destination = {...s.dst, logs: []};
    expect((await s.tracker.trackIntent(s.ref)).state).toBe("pending");
  });

  it("requires canonical finalized receipts and matching chain identity", async () => {
    const s = server(fixture.transfers[0]!);
    for (const key of ["canonical", "finalized"] as const) {
      s.state[key] = false;
      expect(await s.tracker.trackIntent(s.ref)).toEqual({state: "pending"});
      s.state[key] = true;
    }
    s.state.wrongChain = true;
    expect(await s.tracker.trackIntent(s.ref)).toEqual({state: "pending"});
  });

  it("reports a finalized reverted source call as failed, never refunded or delivered", async () => {
    const s = server(fixture.transfers[0]!);
    s.state.source = {...s.src, from: s.intent.sender, to: s.source.address, status: "reverted", logs: []};
    expect(await s.tracker.trackIntent(s.ref)).toEqual({state: "failed"});
    expect(await s.tracker.getRecoveryQuotes(s.ref)).toEqual([]);
    s.state.finalized = false;
    expect(await s.tracker.trackIntent(s.ref)).toEqual({state: "pending"});
  });

  it("does not treat token payout as proof of a separately requested executor native drop", async () => {
    const s = server(fixture.transfers[0]!);
    expect((await s.tracker.trackIntent({...s.ref, intentId: s.intentId.replace(/:0$/, ":1")})).state).toBe("partial");
  });

  it("rejects source actor/amount/recipient changes and a packet from another contract", () => {
    const s = sample(fixture.transfers[0]!);
    for (const change of [{sender: actor}, {recipient: actor}, {amount: s.intent.amount + 10n ** 12n}, {minimum: s.intent.minimum + 10n ** 12n}] as const) expect(() => stargateTaxiProof({...s.intent, ...change}, s.src)).toThrow();
    const wrongEndpoint = {...s.src, logs: s.src.logs.filter((l) => l.address.toLowerCase() !== s.source.endpoint.toLowerCase())};
    expect(() => stargateTaxiProof(s.intent, wrongEndpoint)).toThrow(/packet/);
    const proof = stargateTaxiProof(s.intent, s.src);
    expect(stargateTaxiPayout({...proof, amount: proof.amount + 1n}, s.dst)).toBe(false);
    expect(stargateTaxiPayout({...proof, intent: {...proof.intent, recipient: actor}}, s.dst)).toBe(false);
    expect(() => checkStargateReceipt({...s.src, logs: s.src.logs.map((l) => ({...l, transactionHash: wrong}))}, s.src.transactionHash, s.src.blockHash)).toThrow(/foreign/);
  });

  it("uses a separately supplied recovery hash as discovery, still requiring payout proof", async () => {
    const s = server(fixture.transfers[0]!);
    s.state.indexed = false;
    expect((await s.tracker.trackIntent(s.ref)).state).toBe("pending");
    expect((await s.tracker.trackIntent({...s.ref, recoveryChain: s.destination.chain, recoveryTxHash: s.dst.transactionHash})).state).toBe("completed");
    expect((await s.tracker.trackIntent({...s.ref, recoveryChain: s.source.chain, recoveryTxHash: s.dst.transactionHash})).state).toBe("pending");
  });

  it("builds cached-token recovery only from the exact on-chain commitment and rechecks it", async () => {
    const s = server(fixture.transfers[0]!);
    s.state.indexed = false;
    s.state.cached = s.cache;
    expect(await s.tracker.trackIntent(s.ref)).toEqual({state: "action-required", depositReceived: true});
    const [q] = await s.tracker.getRecoveryQuotes(s.ref);
    expect(q?.kind).toBe("retry-token");
    expect(q?.tx).toMatchObject({to: s.destination.address, chain: s.destination.chain, value: "0"});
    expect(await s.tracker.verifyRecovery(s.ref, q!, actor)).toBeNull();
    expect(await s.tracker.verifyRecovery(s.ref, {...q!, tx: {...q!.tx, value: "1"}}, actor)).not.toBeNull();
    s.state.cached = wrong;
    expect(await s.tracker.getRecoveryQuotes(s.ref)).toEqual([]);
    expect(await s.tracker.verifyRecovery(s.ref, q!, actor)).not.toBeNull();
    s.state.cached = s.cache;
    s.state.paused = true;
    expect(await s.tracker.getRecoveryQuotes(s.ref)).toEqual([]);
  });

  it("distinguishes verified-message retry from cached-token retry and rejects nil/cleared hashes", async () => {
    const s = server(fixture.transfers[0]!);
    s.state.indexed = false;
    s.state.payload = s.payloadHash;
    const [q] = await s.tracker.getRecoveryQuotes(s.ref);
    expect(q?.kind).toBe("retry-message");
    expect(q?.tx).toMatchObject({to: s.destination.endpoint, value: "0"});
    expect(await s.tracker.verifyRecovery(s.ref, q!, actor)).toBeNull();
    const decoded = decodeFunctionData({abi: ENDPOINT_ABI, data: q!.tx.data as Hex});
    expect(decoded.functionName).toBe("lzReceive");
    for (const cleared of [zero, `0x${"ff".repeat(32)}` as Hex, wrong]) {
      s.state.payload = cleared;
      expect(await s.tracker.getRecoveryQuotes(s.ref)).toEqual([]);
      expect(await s.tracker.verifyRecovery(s.ref, q!, actor)).not.toBeNull();
    }
  });
});
