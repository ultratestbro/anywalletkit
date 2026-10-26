import {describe, expect, it} from "vitest";
import {encodeFunctionData, toFunctionSelector, type Hex} from "viem";
import {diamondCallMismatch, type DiamondExpectation} from "../src/calldata.js";
import {DIAMOND_ABI} from "./fixtures.js";

// Review of round 3 H9: the bridge branch took any selector whose first word looked like an offset
// (a packed Across call carried a fake BridgeData in its message), and compared the bridged amount
// with the input after source swaps (other token, other units).
const VICTIM = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const hex = (n: bigint, bytes: number) => n.toString(16).padStart(bytes * 2, "0");
const bridgeData = (o: {asset: string; minAmount: bigint; sourceSwaps: boolean}) => ({
  transactionId: ZERO32, bridge: "relay", integrator: "awk", referrer: "0x0000000000000000000000000000000000000000" as Hex,
  sendingAssetId: o.asset as Hex, receiver: VICTIM as Hex, minAmount: o.minAmount, destinationChainId: 8453n, hasSourceSwaps: o.sourceSwaps, hasDestinationCall: false,
});
const expect_ = (over: Partial<DiamondExpectation> = {}): DiamondExpectation => ({
  fromToken: USDC, toToken: USDC, amountIn: 1_000_000_000n, receiver: VICTIM, minOut: 1n, destChainId: 8453n, sameChain: false, evmDestination: true, ...over,
});

describe("LI.FI bridge calldata", () => {
  it("a packed facet call carrying a BridgeData look-alike is refused (it is no listed entry point)", () => {
    const sel = toFunctionSelector("function startBridgeTokensViaAcrossV4NativePacked()").slice(2);
    const w = (v: bigint) => hex(v, 32);
    let d = sel + hex(0n, 8) + hex(0x140n, 24) + hex(0n, 8) + hex(BigInt(ATTACKER), 32) + hex(0n, 32) + hex(1n, 32) + hex(8453n, 8) + hex(0n, 32) + hex(0n, 12);
    d += "00".repeat(324 - d.length / 2);
    d += w(0n) + w(320n) + w(352n) + w(0n) + w(0n) + w(BigInt(VICTIM)) + w(10n ** 18n) + w(8453n) + w(0n) + w(0n) + w(0n) + w(0n);
    expect(diamondCallMismatch(`0x${d}`, expect_({fromToken: "0x0000000000000000000000000000000000000000", amountIn: 10n ** 18n}))).toMatch(/unknown Diamond call 0x/);
  });

  it("a listed facet with static facet data (RelayDepository) decodes and is checked", () => {
    const data = encodeFunctionData({abi: DIAMOND_ABI, functionName: "startBridgeTokensViaRelayDepository", args: [bridgeData({asset: USDC, minAmount: 1_000_000_000n, sourceSwaps: false}), {orderId: ZERO32, depositorAddress: VICTIM}]});
    expect(diamondCallMismatch(data, expect_())).toBeNull();
    expect(diamondCallMismatch(data, expect_({receiver: ATTACKER}))).toMatch(/pays/);
  });

  it("after source swaps the bridged amount is the swapped token's: a USDC → WETH → bridge route is accepted", () => {
    const data = encodeFunctionData({abi: DIAMOND_ABI, functionName: "swapAndStartBridgeTokensViaRelayDepository", args: [
      bridgeData({asset: WETH, minAmount: 300_000_000_000_000_000n, sourceSwaps: true}),
      [{callTo: VICTIM, approveTo: VICTIM, sendingAssetId: USDC, receivingAssetId: WETH, fromAmount: 1_000_000_000n, callData: "0x", requiresDeposit: true}],
      {orderId: ZERO32, depositorAddress: VICTIM},
    ]});
    expect(diamondCallMismatch(data, expect_())).toBeNull();
    // the swaps must still spend the input token, at most the input
    expect(diamondCallMismatch(data, expect_({fromToken: WETH}))).toMatch(/spends/);
    expect(diamondCallMismatch(data, expect_({amountIn: 999_999_999n}))).toMatch(/swaps/);
  });
});
