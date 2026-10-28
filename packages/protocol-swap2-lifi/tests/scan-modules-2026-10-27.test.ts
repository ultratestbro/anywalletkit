// Scan 2026-10-27 (modules), G6: the LI.FI Diamond calldata check bound only the first and last swap step and never the
// asset kinds a selector moves. A `*ToNative` call counted a USDC minimum in wei (F20); a middle step could deposit DAI
// under a leftover allowance (F21–F23); a bridge with minAmount = 1 passed (F22). Hostile calldata here, encoded with viem;
// the six live quotes of 2026-10-28 (public li.quest, never signed) must still pass.
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi, toFunctionSelector, type AbiFunction, type Hex} from "viem";
import {diamondCallMismatch, type DiamondExpectation} from "../src/calldata.js";
import {DIAMOND_ABI} from "./fixtures.js";

const VICTIM = "0x1111111111111111111111111111111111111111";
const DEX = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH = "0x4200000000000000000000000000000000000006";
const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const SWAP = "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)";
const V3 = parseAbi([
  `function swapTokensSingleV3ERC20ToERC20(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, ${SWAP} _swapData)`,
  `function swapTokensSingleV3ERC20ToNative(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, ${SWAP} _swapData)`,
  `function swapTokensSingleV3NativeToERC20(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, ${SWAP} _swapData)`,
  `function swapTokensMultipleV3ERC20ToERC20(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, ${SWAP}[] _swapData)`,
  `function swapTokensMultipleV3ERC20ToNative(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, ${SWAP}[] _swapData)`,
  `function swapTokensMultipleV3NativeToERC20(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, ${SWAP}[] _swapData)`,
] as readonly string[]);
type Step = {sendingAssetId: string; receivingAssetId: string; fromAmount: bigint; requiresDeposit: boolean};
const step = (s: Step) => ({callTo: DEX as Hex, approveTo: DEX as Hex, sendingAssetId: s.sendingAssetId as Hex, receivingAssetId: s.receivingAssetId as Hex, fromAmount: s.fromAmount, callData: "0x" as Hex, requiresDeposit: s.requiresDeposit});
const single = (fn: string, s: Step, minOut = 9_900_000_000_000_000n) => encodeFunctionData({abi: V3, functionName: fn as never, args: [ZERO32, "awk", "", VICTIM, minOut, step(s)] as never});
const multiple = (fn: string, steps: Step[], minOut = 9_900_000_000_000_000n) => encodeFunctionData({abi: V3, functionName: fn as never, args: [ZERO32, "awk", "", VICTIM, minOut, steps.map(step)] as never});
const swapExpect = (over: Partial<DiamondExpectation> = {}): DiamondExpectation => ({
  fromToken: USDC, toToken: WETH, amountIn: 10_000_000_000n, receiver: VICTIM, minOut: 9_900_000_000_000_000n, destChainId: 8453n, sameChain: true, evmDestination: true, ...over,
});

describe("the V3 selectors are bound to the asset kinds they move (F20)", () => {
  it("the selector table names the facet's real signatures", () => {
    for (const [fn, sel] of [["swapTokensSingleV3ERC20ToERC20", "0x4666fc80"], ["swapTokensSingleV3ERC20ToNative", "0x733214a3"], ["swapTokensSingleV3NativeToERC20", "0xaf7060fd"],
      ["swapTokensMultipleV3ERC20ToERC20", "0x5fd9ae2e"], ["swapTokensMultipleV3ERC20ToNative", "0x2c57e884"], ["swapTokensMultipleV3NativeToERC20", "0x736eac0b"]] as const) {
      expect(toFunctionSelector(V3.find((f) => f.type === "function" && f.name === fn) as AbiFunction), fn).toBe(sel);
    }
  });

  it("a ToNative selector with an ERC-20 destination is refused (its minimum would be counted in wei)", () => {
    const toNative = single("swapTokensSingleV3ERC20ToNative", {sendingAssetId: USDC, receivingAssetId: WETH, fromAmount: 10_000_000_000n, requiresDeposit: true}, 9_950_000_000n);
    expect(diamondCallMismatch(toNative, swapExpect({toToken: USDC, minOut: 9_950_000_000n}))).toMatch(/delivers the native coin, but the output is a token/);
    expect(diamondCallMismatch(multiple("swapTokensMultipleV3ERC20ToNative", [{sendingAssetId: USDC, receivingAssetId: WETH, fromAmount: 10_000_000_000n, requiresDeposit: true}]), swapExpect())).toMatch(/delivers the native coin/);
  });

  it("each direction: ToERC20 for a native output, NativeTo* for a token input, ERC20To* for a native input — refused; the matching kinds pass", () => {
    const toErc20 = single("swapTokensSingleV3ERC20ToERC20", {sendingAssetId: USDC, receivingAssetId: ZERO, fromAmount: 10_000_000_000n, requiresDeposit: true});
    expect(diamondCallMismatch(toErc20, swapExpect({toToken: ZERO}))).toMatch(/delivers a token, but the output is the native coin/);
    const nativeIn = single("swapTokensSingleV3NativeToERC20", {sendingAssetId: USDC, receivingAssetId: WETH, fromAmount: 10_000_000_000n, requiresDeposit: false});
    expect(diamondCallMismatch(nativeIn, swapExpect())).toMatch(/swaps from the native coin, but the input is a token/);
    const erc20In = single("swapTokensSingleV3ERC20ToERC20", {sendingAssetId: ZERO, receivingAssetId: WETH, fromAmount: 10n ** 18n, requiresDeposit: false});
    expect(diamondCallMismatch(erc20In, swapExpect({fromToken: ZERO, amountIn: 10n ** 18n}))).toMatch(/swaps from a token, but the input is the native coin/);
    expect(diamondCallMismatch(single("swapTokensSingleV3ERC20ToERC20", {sendingAssetId: USDC, receivingAssetId: WETH, fromAmount: 10_000_000_000n, requiresDeposit: true}), swapExpect())).toBeNull();
    expect(diamondCallMismatch(single("swapTokensSingleV3ERC20ToNative", {sendingAssetId: USDC, receivingAssetId: ZERO, fromAmount: 10_000_000_000n, requiresDeposit: true}), swapExpect({toToken: ZERO}))).toBeNull();
  });
});

describe("every swap step is checked, not only the ends (F21–F23)", () => {
  const fee: Step = {sendingAssetId: USDC, receivingAssetId: USDC, fromAmount: 25_000_000n, requiresDeposit: true};
  const swap: Step = {sendingAssetId: USDC, receivingAssetId: WETH, fromAmount: 9_975_000_000n, requiresDeposit: true};

  it("a multi-step route whose middle step deposits DAI is refused", () => {
    const dai: Step = {sendingAssetId: DAI, receivingAssetId: WETH, fromAmount: 50_000n * 10n ** 18n, requiresDeposit: true};
    const data = multiple("swapTokensMultipleV3ERC20ToERC20", [fee, {...swap, receivingAssetId: DAI, requiresDeposit: false}, dai, {sendingAssetId: WETH, receivingAssetId: WETH, fromAmount: 1n, requiresDeposit: false}]);
    expect(diamondCallMismatch(data, swapExpect())).toMatch(/step 2 pulls 0x50c5725949a6f0c72e6c4a641f24049a917db0cb from the wallet, not the input/);
  });

  it("steps that do not chain, or deposits beyond the input, are refused; a fee step on the input is fine", () => {
    expect(diamondCallMismatch(multiple("swapTokensMultipleV3ERC20ToERC20", [fee, swap]), swapExpect())).toBeNull();
    const jump = multiple("swapTokensMultipleV3ERC20ToERC20", [fee, {sendingAssetId: DAI, receivingAssetId: WETH, fromAmount: 1n, requiresDeposit: false}]);
    expect(diamondCallMismatch(jump, swapExpect())).toMatch(/step 1 spends .* which step 0 does not deliver/);
    const twice = multiple("swapTokensMultipleV3ERC20ToERC20", [{...fee, fromAmount: 5_000_000_000n}, {...swap, fromAmount: 5_000_000_001n}]);
    expect(diamondCallMismatch(twice, swapExpect())).toMatch(/pull 10000000001 from the wallet, more than the 10000000000 spent/);
  });
});

describe("a bridge without source swaps pulls the input (F22)", () => {
  const bridge = (minAmount: bigint) => encodeFunctionData({abi: DIAMOND_ABI, functionName: "startBridgeTokensViaRelayDepository", args: [{
    transactionId: ZERO32, bridge: "relay", integrator: "awk", referrer: ZERO as Hex, sendingAssetId: USDC as Hex, receiver: VICTIM as Hex, minAmount,
    destinationChainId: 42161n, hasSourceSwaps: false, hasDestinationCall: false,
  }, {orderId: ZERO32, depositorAddress: DEX as Hex}]});
  const e = swapExpect({toToken: USDC, sameChain: false, destChainId: 42161n, minOut: 1n, amountIn: 1_000_000n});
  it("a bridge with minAmount = 1 is refused; the input, or a bridge fee of up to 1 % (Glacis 0.25 %), passes", () => {
    expect(diamondCallMismatch(bridge(1n), e)).toMatch(/bridges 1, not the 1000000 spent/);
    expect(diamondCallMismatch(bridge(980_000n), e)).toMatch(/bridges 980000/);
    expect(diamondCallMismatch(bridge(1_000_001n), e)).toMatch(/bridges 1000001/);
    expect(diamondCallMismatch(bridge(1_000_000n), e)).toBeNull();
    expect(diamondCallMismatch(bridge(997_500n), e)).toBeNull();
  });
});

describe("the live LI.FI quotes of 2026-10-28 pass (golden)", () => {
  const live = JSON.parse(readFileSync(new URL("./fixtures-live-2026-10-28.json", import.meta.url), "utf8")) as {quotes: Array<{fromChainId: number; toChainId: number; fromToken: string; toToken: string; fromAmount: string; toAddress: string; toAmountMin: string; tool: string; data: string}>};
  it(`all ${live.quotes.length} decode and match what they quote: fee step + swap or bridge`, () => {
    expect(live.quotes.length).toBeGreaterThanOrEqual(6);
    for (const q of live.quotes) {
      const why = diamondCallMismatch(q.data, {
        fromToken: q.fromToken, toToken: q.toToken, amountIn: BigInt(q.fromAmount), receiver: q.toAddress, minOut: q.fromChainId === q.toChainId ? BigInt(q.toAmountMin) : 1n,
        destChainId: BigInt(q.toChainId), sameChain: q.fromChainId === q.toChainId, evmDestination: true,
      });
      expect(why, `${q.fromChainId}→${q.toChainId} ${q.tool}`).toBeNull();
    }
    expect(ATTACKER).toBeTypeOf("string");
  });
});
