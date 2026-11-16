import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {decodeAbiParameters, encodeAbiParameters, encodePacked, getAbiItem, parseEventLogs, type Hex, type TransactionReceipt} from "viem";
import {COMPOSE_ABI, LIFI_COMPOSE_ABI, LIFI_COMPOSE_PAYLOAD, LIFI_ETHEREUM_COMPOSER, lifiStargateComposeOutcome, proveLifiStargateCompose, stargateComposeOptions, stargateComposeQueueState, type StargateComposeExpectation} from "../src/compose.js";
import {stargateTaxiProof} from "../src/tracking.js";

type Side = {receipt: TransactionReceipt; transaction: {hash: Hex}; block: {hash: Hex}};
type Recorded = {guid: Hex; expected: StargateComposeExpectation; source: Side; delivery: Side; execution: Side; code: {receiver: Hex; executor: Hex}; calls: {functionName: string; result: Hex}[]; outcome: {state: string; amount: string}; discovery: {scanComposeStatus: string}};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/compose.json", import.meta.url), "utf8")) as {cases: Recorded[]};
const other: Hex = "0x1111111111111111111111111111111111111111";
function sample(index = 0) {
  const c = fixture.cases[index]!;
  const expected = {...c.expected, minimum: BigInt(c.expected.minimum), bridge: {...c.expected.bridge, amount: BigInt(c.expected.bridge.amount), minimum: BigInt(c.expected.bridge.minimum), nativeDrop: BigInt(c.expected.bridge.nativeDrop)}};
  const receipt = (side: Side) => ({...side.receipt, blockNumber: BigInt(side.receipt.blockNumber), logs: side.receipt.logs.map((l) => ({...l, blockNumber: BigInt(l.blockNumber!)}))});
  const source = receipt(c.source), delivery = receipt(c.delivery), execution = receipt(c.execution);
  return {c, expected, source, delivery, execution, proof: proveLifiStargateCompose(expected, source, delivery, c.code)};
}

describe("recorded LI.FI Stargate compose evidence (read-only)", () => {
  it("proves final ERC20 payment, not the input asset/gross balance in Completed", () => {
    const s = sample();
    const completed = parseEventLogs({abi: LIFI_COMPOSE_ABI, eventName: "LiFiTransferCompleted", logs: s.execution.logs})[0]!;
    expect(completed.args.receivingAssetId).toBe(s.expected.bridge.destination.token);
    expect(completed.args.receivingAssetId).not.toBe(s.expected.finalToken);
    expect(lifiStargateComposeOutcome(s.proof, s.execution)).toEqual({state: "completed", token: s.expected.finalToken, amount: BigInt(s.c.outcome.amount), transactionHash: s.execution.transactionHash});
    expect(s.proof.executionSupported).toBe(false);
    expect(lifiStargateComposeOutcome(s.proof, s.delivery)).toEqual({state: "unverified"});
    expect(() => stargateTaxiProof(s.expected.bridge, s.source)).toThrow(/compose/);
  });

  it("reports returned intermediate tokens even when Scan says compose SUCCEEDED", () => {
    const s = sample(1);
    expect(s.c.discovery.scanComposeStatus).toBe("SUCCEEDED");
    expect(lifiStargateComposeOutcome(s.proof, s.execution)).toEqual({state: "intermediate-refunded", token: s.expected.bridge.destination.token, amount: BigInt(s.c.outcome.amount), transactionHash: s.execution.transactionHash});
    expect(s.expected.finalToken).not.toBe(s.expected.bridge.destination.token);
  });

  it("authenticates the queued message and recognizes consumed commitments", () => {
    for (const index of [0, 1]) {
      const s = sample(index), calls = s.c.calls.filter((c) => c.functionName === "composeQueue");
      expect(stargateComposeQueueState(s.proof.messageHash, calls[0]!.result)).toBe("pending");
      expect(stargateComposeQueueState(s.proof.messageHash, calls[1]!.result)).toBe("consumed");
      expect(BigInt(calls[1]!.result)).toBe(1n);
      expect(stargateComposeQueueState(s.proof.messageHash, `0x${"00".repeat(32)}`)).toBe("absent");
      expect(stargateComposeQueueState(s.proof.messageHash, `0x${"ab".repeat(32)}`)).toBe("mismatch");
    }
  });

  it("requires exact gas bounds and index-zero type-3 encoding", () => {
    const gas = 200000n;
    expect(stargateComposeOptions(gas)).toBe(encodePacked(["uint16", "uint8", "uint16", "uint8", "uint16", "uint128"], [3, 1, 19, 3, 0, gas]));
    for (const invalid of [0n, -1n, 1n << 128n]) expect(() => stargateComposeOptions(invalid)).toThrow();
  });

  it("rejects changed composer bytecode, actors, payload, final asset and queue message", () => {
    const s = sample();
    const prove = (expected = s.expected, delivery = s.delivery, code = s.c.code) => proveLifiStargateCompose(expected, s.source, delivery, code);
    expect(() => prove(s.expected, s.delivery, {...s.c.code, receiver: "0x00"})).toThrow(/bytecode/);
    expect(() => prove(s.expected, s.delivery, {...s.c.code, executor: "0x00"})).toThrow(/bytecode/);
    for (const expected of [
      {...s.expected, recipient: other}, {...s.expected, finalToken: other}, {...s.expected, minimum: 0n},
      {...s.expected, composeFrom: other}, {...s.expected, composeMsg: `${s.expected.composeMsg}00` as Hex},
      {...s.expected, bridge: {...s.expected.bridge, recipient: other}},
    ]) expect(() => prove(expected)).toThrow();
    const queued = parseEventLogs({abi: COMPOSE_ABI, eventName: "ComposeSent", logs: s.delivery.logs})[0]!;
    expect(() => prove(s.expected, {...s.delivery, logs: s.delivery.logs.filter((l) => l.logIndex !== queued.logIndex)})).toThrow(/queue/);
    expect(() => prove(s.expected, {...s.delivery, logs: s.delivery.logs.map((l) => l.logIndex === queued.logIndex ? {...l, address: other} : l)})).toThrow(/queue/);
    expect(() => prove(s.expected, {...s.delivery, logs: s.delivery.logs.map((l) => ({...l, removed: true}))})).toThrow(/removed/);
  });

  it("requires final-token transfer evidence and enforces the caller's output floor", () => {
    const s = sample();
    expect(lifiStargateComposeOutcome({...s.proof, minimum: BigInt(s.c.outcome.amount) + 1n}, s.execution)).toEqual({state: "unverified"});
    const transfers = parseEventLogs({abi: LIFI_COMPOSE_ABI, eventName: "Transfer", logs: s.execution.logs.filter((l) => l.address.toLowerCase() === s.expected.finalToken.toLowerCase())});
    const indexes = transfers.map((l) => l.logIndex);
    expect(indexes.length).toBeGreaterThan(0);
    expect(lifiStargateComposeOutcome(s.proof, {...s.execution, logs: s.execution.logs.filter((l) => !indexes.includes(l.logIndex))})).toEqual({state: "unverified"});
    expect(lifiStargateComposeOutcome(s.proof, {...s.execution, status: "reverted"})).toEqual({state: "unverified"});
  });

  it("rejects foreign GUID, index, composer, recipient, event emitters and removed logs", () => {
    const s = sample();
    const event = parseEventLogs({abi: COMPOSE_ABI, eventName: "ComposeDelivered", logs: s.execution.logs})[0]!;
    const abi = getAbiItem({abi: COMPOSE_ABI, name: "ComposeDelivered"});
    for (const args of [
      {...event.args, guid: `0x${"ab".repeat(32)}` as Hex}, {...event.args, to: other}, {...event.args, from: other}, {...event.args, index: 1},
    ]) {
      const mutated = {...s.execution, logs: s.execution.logs.map((l) => l.logIndex === event.logIndex ? {...l, data: encodeAbiParameters(abi.inputs, [args.from, args.to, args.guid, args.index])} : l)};
      expect(lifiStargateComposeOutcome(s.proof, mutated)).toEqual({state: "unverified"});
    }
    for (const receipt of [
      {...s.execution, logs: s.execution.logs.map((l) => l.address.toLowerCase() === LIFI_ETHEREUM_COMPOSER.executor.toLowerCase() ? {...l, address: other} : l)},
      {...s.execution, logs: s.execution.logs.map((l) => ({...l, removed: true}))},
    ]) expect(lifiStargateComposeOutcome(s.proof, receipt)).toEqual({state: "unverified"});
    expect(lifiStargateComposeOutcome({...s.proof, recipient: other}, s.execution)).toEqual({state: "unverified"});
  });

  it("never treats a refund event without the bridged-token transfer as a payout", () => {
    const s = sample(1);
    const logs = s.execution.logs.filter((l) => l.address.toLowerCase() !== s.expected.bridge.destination.token.toLowerCase());
    expect(lifiStargateComposeOutcome(s.proof, {...s.execution, logs})).toEqual({state: "unverified"});
    expect(lifiStargateComposeOutcome(sample().proof, s.execution)).toEqual({state: "unverified"});
  });

  it("keeps arbitrary nested calldata out of the executable route surface", () => {
    const s = sample(1);
    const [, swaps] = decodeAbiParameters(LIFI_COMPOSE_PAYLOAD, s.expected.composeMsg);
    expect(swaps[0]!.callData.slice(0, 10)).toBe("0xd33721a5");
    expect(s.proof.executionSupported).toBe(false);
    expect(Object.isFrozen(s.proof)).toBe(true);
  });
});
