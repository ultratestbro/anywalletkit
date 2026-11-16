import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {encodeAbiParameters, encodeEventTopics, parseEventLogs, toHex, type Hex, type TransactionReceipt} from "viem";
import {ENDPOINT_ABI, TOKEN_MESSAGING_ABI} from "../src/abi.js";
import {stargateBusNativeDrop, stargateBusPayout, stargateBusProof, stargateBusTicket} from "../src/bus.js";
import {stargateRegistry} from "../src/deployments.js";
import {parseStargateIntent} from "../src/intent.js";
import {checkStargateReceipt, createStargateTracker} from "../src/tracking.js";

type Side = {chain: string; chainId: number; block: {number: string; hash: Hex; timestamp: string}; receipt: {transactionHash: Hex; status: string; blockNumber: string; blockHash: Hex; logs: Array<Record<string, unknown>>}};
type Rider = {ticketId: string; seat: number; assetId: number; source: Side; intent: {sender: Hex; recipient: Hex; amount: string; minimum: string; nativeDrop: string}};
type Bus = {guid: Hex; drive: Side; destination: Side & {transaction?: {from: Hex; input: Hex; value: string}}; riders: Rider[]; manualExecution?: {beforeBlock: Side["block"]; calls: {to: Hex; data: Hex; result: Hex; functionName: string; blockNumber: string}[]}};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/bus-receipts.json", import.meta.url), "utf8")) as {kind: string; buses: Bus[]};
function receipt(side: Side): TransactionReceipt {
  return {...side.receipt, blockNumber: BigInt(side.receipt.blockNumber), logs: side.receipt.logs.map((l) => ({...l, blockNumber: BigInt(String(l.blockNumber))}))} as unknown as TransactionReceipt;
}
function sample(b: Bus, r: Rider) {
  const source = stargateRegistry.deployments.find((d) => d.chain === r.source.chain && d.assetId === r.assetId)!;
  const destination = stargateRegistry.deployments.find((d) => d.chain === b.destination.chain && d.assetId === r.assetId)!;
  const intentId = ["stargate", 1, source.eid, destination.eid, r.assetId, "bus", r.intent.sender.toLowerCase(), r.intent.recipient.toLowerCase(), r.intent.amount, r.intent.minimum, r.intent.nativeDrop].join(":");
  const intent = parseStargateIntent(intentId, stargateRegistry);
  const ticket = stargateBusTicket(intent, receipt(r.source));
  const proof = stargateBusProof(ticket, receipt(b.drive));
  return {intentId, ticket, proof, dst: receipt(b.destination)};
}

describe("historical mainnet Bus receipts", () => {
  it("covers mixed assets, native transfers and native drop without synthetic receipts", () => {
    expect(fixture.kind).toBe("historical-mainnet-bus-receipts");
    expect(fixture.buses.map((b) => b.riders.length)).toEqual([4, 2, 4, 2]);
    expect(new Set(fixture.buses[0]!.riders.map((r) => r.assetId)).size).toBe(2);
    expect(fixture.buses.flatMap((b) => b.riders).filter((r) => BigInt(r.intent.nativeDrop) > 0n)).toHaveLength(1);
  });
  for (const b of fixture.buses) for (const r of b.riders) it(`${b.guid.slice(0, 10)} seat ${r.seat}: authenticates ticket, batch and passenger payout`, async () => {
    const s = sample(b, r);
    for (const side of [r.source, b.drive, b.destination]) checkStargateReceipt(receipt(side), side.receipt.transactionHash, side.block.hash);
    expect(s.ticket.ticketId).toBe(BigInt(r.ticketId));
    expect(s.proof.seat).toBe(r.seat);
    expect(s.proof.guid).toBe(b.guid);
    expect(stargateBusPayout(s.proof, s.dst)).toBe("paid");
    expect(stargateBusNativeDrop(s.proof, s.dst)).toBe(BigInt(r.intent.nativeDrop) > 0n);
    const sides = [r.source, b.drive, b.destination];
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).startsWith("https://scan.test")) return Response.json({data: [{guid: b.guid, destination: {tx: {txHash: b.destination.receipt.transactionHash}}}]});
      const request = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
      const chain = String(url).includes("source.test") ? b.drive.chain : b.destination.chain;
      const head = chain === b.drive.chain ? b.drive : b.destination;
      let result: unknown;
      if (request.method === "eth_chainId") result = toHex(head.chainId);
      else if (request.method === "eth_getTransactionReceipt") {
        const side = sides.find((side) => side.chain === chain && side.receipt.transactionHash === request.params[0]);
        if (!side) throw new Error("Unexpected receipt");
        const value = receipt(side);
        result = {...value, blockNumber: toHex(value.blockNumber), status: "0x1", logs: value.logs.map((l) => ({...l, blockNumber: toHex(l.blockNumber!), logIndex: toHex(l.logIndex!), transactionIndex: toHex(l.transactionIndex!)}))};
      } else if (request.method === "eth_getBlockByNumber") {
        const finalized = request.params[0] === "finalized";
        const side = finalized ? head : sides.find((side) => side.chain === chain && BigInt(side.block.number) === BigInt(String(request.params[0])));
        if (!side) throw new Error("Unexpected block");
        result = {number: toHex(BigInt(side.block.number) + (finalized ? 100n : 0n)), hash: side.block.hash, timestamp: toHex(BigInt(side.block.timestamp)), transactions: []};
      } else throw new Error(`Unexpected RPC ${request.method}`);
      return Response.json({jsonrpc: "2.0", id: request.id, result});
    };
    const tracker = createStargateTracker({rpcUrls: {[b.drive.chain]: "https://source.test", [b.destination.chain]: "https://destination.test"}, fetchImpl, scanUrl: "https://scan.test", findBusDrive: async () => [b.drive.receipt.transactionHash]});
    expect(await tracker.trackIntent({intentId: s.intentId, sourceTxHash: r.source.receipt.transactionHash})).toEqual({state: "completed", depositReceived: true, destTxHash: b.destination.receipt.transactionHash});
  });

  it("rejects failed, missing, foreign or ambiguously attributed native drops (mutated evidence)", () => {
    const b = fixture.buses[2]!, s = sample(b, b.riders[2]!);
    const drops = parseEventLogs({abi: TOKEN_MESSAGING_ABI, eventName: "NativeDropApplied", logs: s.dst.logs});
    expect(drops).toHaveLength(1);
    const drop = drops[0]!;
    const delivered = parseEventLogs({abi: ENDPOINT_ABI, eventName: "PacketDelivered", logs: s.dst.logs})[0]!;
    const altered = (logs: TransactionReceipt["logs"]) => stargateBusNativeDrop(s.proof, {...s.dst, logs});
    expect(altered(s.dst.logs.filter((l) => l.logIndex !== drop.logIndex))).toBe(false);
    expect(altered(s.dst.logs.map((l) => l.logIndex === drop.logIndex ? {...l, topics: encodeEventTopics({abi: TOKEN_MESSAGING_ABI, eventName: "NativeDropFailed", args: drop.args}) as [Hex, ...Hex[]]} : l))).toBe(false);
    expect(altered(s.dst.logs.map((l) => l.logIndex === drop.logIndex ? {...l, data: encodeAbiParameters([{type: "address"}, {type: "uint128"}], [drop.args.receiver, drop.args.amount + 1n])} : l))).toBe(false);
    expect(stargateBusNativeDrop({...s.proof, nonce: s.proof.nonce + 1n}, s.dst)).toBe(false);
    expect(altered([...s.dst.logs, {...delivered, logIndex: delivered.logIndex! + 1}])).toBe(false);
    expect(altered(s.dst.logs.map((l) => l.logIndex === drop.logIndex ? {...l, logIndex: delivered.logIndex! + 1} : l))).toBe(false);
    expect(stargateBusPayout(s.proof, s.dst)).toBe("paid");
  });

  it("replays real pending payload → manual Endpoint execution → each passenger's payout", async () => {
    const b = fixture.buses.find((b) => b.manualExecution)!;
    expect(b).toBeDefined();
    const evidence = b.manualExecution!;
    const commits = evidence.calls.filter((c) => c.functionName === "inboundPayloadHash");
    expect(commits[0]!.result).not.toBe(`0x${"00".repeat(32)}`);
    expect(commits[1]!.result).toBe(`0x${"00".repeat(32)}`);
    for (const rider of b.riders) {
      const s = sample(b, rider);
      let delivered = false;
      const fetchImpl: typeof fetch = async (url, init) => {
        if (String(url).startsWith("https://scan.test")) return Response.json({data: [{guid: b.guid, destination: {tx: {txHash: b.destination.receipt.transactionHash}}}]});
        const req = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
        const source = String(url).includes("source.test");
        const sides = source ? [rider.source, b.drive] : [b.destination];
        let result: unknown;
        if (req.method === "eth_chainId") result = toHex(sides[0]!.chainId);
        else if (req.method === "eth_getTransactionReceipt") {
          const side = sides.find((side) => side.receipt.transactionHash === req.params[0]);
          if (!side || (!source && !delivered)) result = null;
          else {
            const r = receipt(side);
            result = {...r, status: "0x1", blockNumber: toHex(r.blockNumber), logs: r.logs.map((l) => ({...l, blockNumber: toHex(l.blockNumber!), logIndex: toHex(l.logIndex!), transactionIndex: toHex(l.transactionIndex!)}))};
          }
        } else if (req.method === "eth_getBlockByNumber") {
          const finalized = req.params[0] === "finalized";
          const block = finalized ? source ? b.drive.block : delivered ? b.destination.block : evidence.beforeBlock : sides.find((side) => BigInt(side.block.number) === BigInt(String(req.params[0])))?.block;
          if (!block) throw new Error("Unexpected historical block");
          result = {number: toHex(BigInt(block.number)), hash: block.hash, timestamp: toHex(BigInt(block.timestamp)), transactions: []};
        } else if (req.method === "eth_call") {
          const call = req.params[0] as {to: Hex; data: Hex};
          const rows = evidence.calls.filter((c) => c.to.toLowerCase() === call.to.toLowerCase() && c.data === call.data);
          if (!rows.length) throw new Error("Unrecorded contract call");
          result = (delivered ? rows.at(-1) : rows[0])!.result;
        } else throw new Error(`Unexpected RPC ${req.method}`);
        return Response.json({id: req.id, jsonrpc: "2.0", result});
      };
      const tracker = createStargateTracker({rpcUrls: {[b.drive.chain]: "https://source.test", [b.destination.chain]: "https://destination.test"}, fetchImpl, scanUrl: "https://scan.test", findBusDrive: async () => [b.drive.receipt.transactionHash]});
      const ref = {intentId: s.intentId, sourceTxHash: rider.source.receipt.transactionHash};
      expect((await tracker.trackIntent(ref)).state).toBe("action-required");
      const [q] = await tracker.getRecoveryQuotes(ref);
      expect(q).toMatchObject({kind: "retry-message", tx: {value: b.destination.transaction!.value}});
      expect(q!.tx.data!.toLowerCase()).toBe(b.destination.transaction!.input.toLowerCase());
      expect(await tracker.verifyRecovery(ref, q!, b.destination.transaction!.from)).toBeNull();
      delivered = true;
      expect((await tracker.trackIntent(ref)).state).toBe("completed");
      expect(await tracker.getRecoveryQuotes(ref)).toEqual([]);
      expect(await tracker.verifyRecovery(ref, q!, b.destination.transaction!.from)).not.toBeNull();
    }
  });
});
