import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {decodeAbiParameters, decodeFunctionData, encodeFunctionData, pad, type Hex, type TransactionReceipt} from "viem";
import type {Quote} from "@anywalletkit/protocol-swap2-core/types";
import {STARGATE_ABI} from "../src/abi.js";
import {LIFI_COMPOSE_PAYLOAD, LIFI_ETHEREUM_COMPOSER, lifiStargateComposeOutcome, proveLifiStargateCompose, stargateComposeOptions, type StargateComposeExpectation} from "../src/compose.js";
import {COMPOSE_DEX_PINS, COMPOSE_UNOSWAP_ABI} from "../src/compose-dex.js";
import {checkedStargateComposeQuote, isStargateComposeIntent, parseStargateComposeIntent, stargateComposeIntentId, stargateComposeMessage, stargateComposeProof, stargateComposeRetryGas, stargateComposeSendParam, stargateComposeSwapCall, type StargateComposeIntent} from "../src/compose-route.js";
import {stargateRegistry} from "../src/deployments.js";
import {parseStargateIntent} from "../src/intent.js";
import {stargateFees} from "../src/source-tx.js";

type Side = {receipt: TransactionReceipt};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/compose.json", import.meta.url), "utf8")) as {cases: {expected: StargateComposeExpectation & {composeMsg: Hex}; source: Side; delivery: Side; execution: Side; code: {receiver: Hex; executor: Hex}}[]};
const recorded = fixture.cases[0]!;
const [recordedId, [recordedSwap], recordedRecipient] = decodeAbiParameters(LIFI_COMPOSE_PAYLOAD, recorded.expected.composeMsg);
const recordedCall = decodeFunctionData({abi: COMPOSE_UNOSWAP_ABI, data: recordedSwap!.callData});
const source = stargateRegistry.deployments.find((d) => d.chain === "eip155:42161" && d.assetId === 1)!;
const destination = stargateRegistry.deployments.find((d) => d.chain === "eip155:1" && d.assetId === 1)!;
const user: Hex = "0x670463806740eF6468C69eb2996625Bc7d6eEC6b";

/** The recorded LI.FI route's swap parameters, rebuilt by this SDK's encoder. */
function intent(overrides: Partial<StargateComposeIntent> = {}): StargateComposeIntent {
  const [, amount, minReturn, dex0, dex1] = recordedCall.args;
  return {bridge: {source, destination, mode: "taxi", sender: user, recipient: LIFI_ETHEREUM_COMPOSER.receiver, amount: 98_133_750n, minimum: amount, nativeDrop: 0n},
    recipient: recordedRecipient, finalToken: recordedSwap!.receivingAssetId, dex: [dex0, dex1], minReturn, gas: 500_000n, transactionId: recordedId, ...overrides};
}
function quote(c: StargateComposeIntent, cap = 1000n): Quote {
  const protocolFee = c.bridge.amount - c.bridge.minimum;
  const data = encodeFunctionData({abi: STARGATE_ABI, functionName: "sendToken", args: [stargateComposeSendParam(c), {nativeFee: cap, lzTokenFee: 0n}, c.bridge.sender]});
  return {provider: "stargate", routeId: "compose", intentId: `${stargateComposeIntentId(c)}~sealed`, depositAddress: "", depositMemo: null,
    sourceAmount: String(c.bridge.amount), destAmount: String(c.minReturn + 1n), minDestAmount: String(c.minReturn),
    txRequest: {to: source.address, data, value: String(cap), nativeFee: String(cap), chainId: source.chainId, approvalAddress: source.address},
    feeUsd: 0, etaSeconds: null, reliability: 0.85, validUntilMs: Date.now() + 60_000, fees: stargateFees(source, protocolFee, cap),
    providerData: {sentAmount: String(c.bridge.amount), dust: "0", protocolFee: String(protocolFee), protocolReward: "0", messagingFee: String(cap - 1n), nativeDrop: "0"}};
}

describe("executable Stargate compose route", () => {
  it("encodes exactly the recorded LI.FI payload, without the observed calldata suffix", () => {
    const c = intent(), [id, [swap], to] = decodeAbiParameters(LIFI_COMPOSE_PAYLOAD, stargateComposeMessage(c));
    expect([id, to]).toEqual([recordedId, recordedRecipient]);
    expect({...swap, callData: undefined}).toEqual({...recordedSwap, callData: undefined});
    expect(recordedSwap!.callData.toLowerCase()).toBe(`${stargateComposeSwapCall(c).toLowerCase()}${COMPOSE_DEX_PINS.calldataSuffix}`);
    const send = stargateComposeSendParam(c);
    expect(send).toMatchObject({dstEid: destination.eid, to: pad(LIFI_ETHEREUM_COMPOSER.receiver, {size: 32}), amountLD: c.bridge.amount, minAmountLD: c.bridge.minimum, extraOptions: stargateComposeOptions(500_000n), oftCmd: "0x"});
  });

  it("round-trips the self-contained intent and refuses edited or unsupported fields", () => {
    const c = intent(), id = stargateComposeIntentId(c);
    expect(isStargateComposeIntent(id)).toBe(true);
    expect(parseStargateComposeIntent(`${id}~server-envelope`, stargateRegistry)).toEqual(c);
    expect(() => parseStargateIntent(id, stargateRegistry)).toThrow(/intent identity/);
    const fields = id.split(":"), edit = (index: number, value: string) => fields.map((f, i) => i === index ? value : f).join(":");
    for (const bad of [
      edit(1, "1"), edit(4, "30110"), fields.slice(0, 15).join(":"),
      edit(10, destination.token.toLowerCase()), // output equals the bridged asset
      edit(11, `0x${(c.dex[0] | (1n << 250n)).toString(16)}`), edit(12, `0x${(c.dex[1] | (1n << 252n)).toString(16)}`), // Permit2 and unwrap are refused
      edit(11, `0x0${c.dex[0].toString(16)}`), // noncanonical hex
      edit(14, "100000"), edit(14, "3000000"), edit(15, `0x${"00".repeat(32)}`), edit(13, "0"),
    ]) expect(() => parseStargateComposeIntent(bad, stargateRegistry), bad).toThrow();
    const toBase = edit(4, String(stargateRegistry.deployments.find((d) => d.chain === "eip155:8453" && d.assetId === 1)!.eid));
    expect(() => parseStargateComposeIntent(toBase, stargateRegistry)).toThrow(/compose route/);
  });

  it("accepts only the canonical source call and exact bridge accounting", () => {
    const c = intent(), q = quote(c);
    expect(checkedStargateComposeQuote(q, stargateRegistry).compose).toEqual(c);
    const other: Hex = "0x1111111111111111111111111111111111111111";
    const mutate = (patch: (q: Quote) => void) => { const copy = structuredClone(q); patch(copy); return () => checkedStargateComposeQuote(copy, stargateRegistry); };
    const foreign = encodeFunctionData({abi: STARGATE_ABI, functionName: "sendToken", args: [stargateComposeSendParam({...c, recipient: other}), {nativeFee: 1000n, lzTokenFee: 0n}, c.bridge.sender]});
    expect(mutate((x) => { x.txRequest!.data = foreign; })).toThrow(/calldata/);
    expect(mutate((x) => { x.txRequest!.data = `${x.txRequest!.data}00`; })).toThrow(/calldata/);
    expect(mutate((x) => { x.minDestAmount = String(c.minReturn - 1n); })).toThrow(/identity/);
    expect(mutate((x) => { x.destAmount = String(c.minReturn - 1n); })).toThrow(/output/);
    expect(mutate((x) => { x.txRequest!.value = "1001"; })).toThrow(/native value/);
    expect(mutate((x) => { delete x.txRequest!.approvalAddress; })).toThrow(/spender/);
    expect(mutate((x) => { x.txRequest!.gasLimit = "1"; })).toThrow(/unexpected/);
    expect(mutate((x) => { x.routeId = "taxi"; })).toThrow(/missing/);
    expect(mutate((x) => { x.providerData!.protocolFee = String(BigInt(x.providerData!.protocolFee!) + 1n); })).toThrow(/accounting/);
    expect(mutate((x) => { x.validUntilMs = Date.now() - 1; })).toThrow(/expired/);
  });

  it("retries with enough gas for the swap above the receiver's reserve", () => {
    expect(stargateComposeRetryGas(intent(), 100_000n)).toBe(750_000n);
    expect(stargateComposeRetryGas(intent({gas: 300_000n}), 100_000n)).toBe(600_000n);
  });

  it("feeds the recorded execution into the same payout adapter", () => {
    const e = recorded.expected, receipt = (side: Side) => ({...side.receipt, blockNumber: BigInt(side.receipt.blockNumber), logs: side.receipt.logs.map((l) => ({...l, blockNumber: BigInt(l.blockNumber!)}))});
    const expected = {...e, minimum: BigInt(e.minimum), bridge: {...e.bridge, amount: BigInt(e.bridge.amount), minimum: BigInt(e.bridge.minimum), nativeDrop: BigInt(e.bridge.nativeDrop)}};
    const historical = proveLifiStargateCompose(expected, receipt(recorded.source), receipt(recorded.delivery), recorded.code);
    const lifi = stargateComposeProof(intent(), historical.bridge);
    expect(lifi.executionSupported).toBe(true);
    expect(lifiStargateComposeOutcome(lifi, receipt(recorded.execution))).toMatchObject({state: "completed", token: recordedSwap!.receivingAssetId});
    expect(lifiStargateComposeOutcome(stargateComposeProof(intent({minReturn: 10n ** 30n}), historical.bridge), receipt(recorded.execution))).toEqual({state: "unverified"});
  });
});
