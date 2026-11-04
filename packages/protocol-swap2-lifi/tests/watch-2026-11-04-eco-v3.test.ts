// EcoFacet v3.0.0 (lifinance/contracts 9001792, 2026-11-01) added `uint64 intentDestination` to EcoData after
// rewardDeadline. Both entry points changed selector — startBridgeTokensViaEco 0x05c54990, swapAndStartBridgeTokensViaEco
// 0x8352664c — and the v2 ones (0xbff90b61 / 0x762aea18) are gone from the Diamonds (facetAddress() = 0 on Ethereum,
// Base, Arbitrum, Optimism, Polygon, BNB Chain; the v3 ones resolve there and on Unichain, Ink and HyperEVM). Every
// LI.FI Eco route was refused as an unknown Diamond call. refundRecipient moves from word 5 to word 6.
// v3 also dropped the facet's own check that the route's final `transfer` pays BridgeData.receiver ("for EVM
// destinations the receiver is therefore enforced only by the backend signature"), and lets the intent run on another
// chain than the destination (CCTP burn, HyperCore deposit, a second intent). The device now reads the route itself.
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector, type Abi, type Hex} from "viem";
import {diamondCallMismatch, type DiamondExpectation} from "../src/calldata.js";

afterEach(() => vi.unstubAllGlobals());

const SENDER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const RECEIVER = "0x3333333333333333333333333333333333333333";
const OTHER = "0x9999999999999999999999999999999999999999";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // Base
const USDC_OP = "0x0b2c639c533813f4aa9d7837caf62653d097ff85"; // Optimism
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"00".repeat(32)}` as Hex;

const B = "(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)";
const S = "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[]";
// EcoFacet.sol v3.0.0, struct EcoData.
const ECO_V3 = "(bytes nonEVMReceiver, address prover, uint64 rewardDeadline, uint64 intentDestination, bytes encodedRoute, bytes32 solanaATA, address refundRecipient, uint256 deadline, bytes signature)";
const ECO_V2 = "(bytes nonEVMReceiver, address prover, uint64 rewardDeadline, bytes encodedRoute, bytes32 solanaATA, address refundRecipient, uint256 deadline, bytes signature)";
const ABI: Abi = parseAbi([
  `function startBridgeTokensViaEco(${B} _bridgeData, ${ECO_V3} _ecoData)`,
  `function swapAndStartBridgeTokensViaEco(${B} _bridgeData, ${S} _swapData, ${ECO_V3} _ecoData)`,
] as readonly string[]);
const V2: Abi = parseAbi([`function startBridgeTokensViaEco(${B} _bridgeData, ${ECO_V2} _ecoData)`] as readonly string[]);
// EcoFacet.sol v3.0.0, struct Route / Call (the portal's route, abi-encoded).
const ROUTE = parseAbiParameters("(bytes32 salt, uint64 deadline, address portal, uint256 nativeAmount, (address token, uint256 amount)[] tokens, (address target, bytes data, uint256 value)[] calls)");
const ERC20 = parseAbi(["function transfer(address to, uint256 amount)", "function approve(address spender, uint256 amount)"]);

type Call = {target: Hex; data: Hex; value: bigint};
const transfer = (to: string, amount: bigint, token = USDC_OP): Call => ({target: token as Hex, data: encodeFunctionData({abi: ERC20, functionName: "transfer", args: [to as Hex, amount]}), value: 0n});
const route = (calls: Call[]) => encodeAbiParameters(ROUTE, [{salt: `0x${"ab".repeat(32)}`, deadline: 2_000_000_000n, portal: OTHER, nativeAmount: 0n, tokens: [{token: USDC_OP, amount: 990_000n}], calls}]);
const bridgeData = (sourceSwaps = false) => ({
  transactionId: ZERO32, bridge: "eco", integrator: "awk", referrer: ZERO as Hex, sendingAssetId: USDC as Hex, receiver: RECEIVER as Hex,
  minAmount: 1_000_000n, destinationChainId: 10n, hasSourceSwaps: sourceSwaps, hasDestinationCall: false,
});
const feeStep = [{callTo: OTHER as Hex, approveTo: OTHER as Hex, sendingAssetId: USDC as Hex, receivingAssetId: USDC as Hex, fromAmount: 1_000_000n, callData: "0x" as Hex, requiresDeposit: true}];
const ecoData = (patch: Record<string, unknown> = {}) => ({
  nonEVMReceiver: "0x" as Hex, prover: OTHER as Hex, rewardDeadline: 2_000_000_000n, intentDestination: 10n, encodedRoute: route([transfer(RECEIVER, 990_000n)]),
  solanaATA: ZERO32, refundRecipient: SENDER as Hex, deadline: 2_000_000_000n, signature: `0x${"11".repeat(65)}` as Hex, ...patch,
});
const call = (patch: Record<string, unknown> = {}, sourceSwaps = false) => encodeFunctionData({
  abi: ABI, functionName: sourceSwaps ? "swapAndStartBridgeTokensViaEco" : "startBridgeTokensViaEco",
  args: (sourceSwaps ? [bridgeData(true), feeStep, ecoData(patch)] : [bridgeData(), ecoData(patch)]) as never,
});
const e: DiamondExpectation = {fromToken: USDC, toToken: USDC_OP, amountIn: 1_000_000n, receiver: RECEIVER, sender: SENDER, minOut: 985_050n, destChainId: 10n, sameChain: false, evmDestination: true};

describe("watch 2026-11-04: EcoFacet v3 (intentDestination)", () => {
  it("the listed selectors are the v3 ones, recomputed from the facet's signatures; a v2 call is now an unknown Diamond call", () => {
    expect(toFunctionSelector(`function startBridgeTokensViaEco(${B} _bridgeData, ${ECO_V3} _ecoData)`)).toBe("0x05c54990");
    expect(toFunctionSelector(`function swapAndStartBridgeTokensViaEco(${B} _bridgeData, ${S} _swapData, ${ECO_V3} _ecoData)`)).toBe("0x8352664c");
    expect(call().slice(0, 10)).toBe("0x05c54990");
    expect(call({}, true).slice(0, 10)).toBe("0x8352664c");
    const v2 = encodeFunctionData({abi: V2, functionName: "startBridgeTokensViaEco", args: [bridgeData(), {nonEVMReceiver: "0x", prover: OTHER, rewardDeadline: 1n, encodedRoute: "0x", solanaATA: ZERO32, refundRecipient: SENDER, deadline: 1n, signature: "0x"}] as never});
    expect(v2.slice(0, 10)).toBe("0xbff90b61");
    expect(diamondCallMismatch(v2, e)).toBe("unknown Diamond call 0xbff90b61");
  });

  it("an honest v3 call passes on both entry points: the intent runs on the destination and its route pays the recipient", () => {
    expect(diamondCallMismatch(call(), e)).toBeNull();
    expect(diamondCallMismatch(call({}, true), e)).toBeNull();
    // Calls before the final transfer are the route's own business: the fill pays the recipient or does not happen.
    const approveFirst: Call = {target: USDC_OP as Hex, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [OTHER as Hex, 1n]}), value: 0n};
    expect(diamondCallMismatch(call({encodedRoute: route([approveFirst, transfer(RECEIVER, 990_000n)])}), e)).toBeNull();
  });

  it("refundRecipient is read at word 6 (v3): another address is refused, the recipient and a zero (the facet refuses it) pass", () => {
    for (const swaps of [false, true]) {
      expect(diamondCallMismatch(call({refundRecipient: OTHER}, swaps), e)).toBe(`Eco refundRecipient pays ${OTHER}, neither the sender ${SENDER} nor the recipient`);
      expect(diamondCallMismatch(call({refundRecipient: RECEIVER}, swaps), e)).toBeNull();
      expect(diamondCallMismatch(call({refundRecipient: ZERO}, swaps), e)).toBeNull();
    }
    // Word 5 (solanaATA in v3, where v2 kept refundRecipient) is not an address the check reads.
    expect(diamondCallMismatch(call({solanaATA: `0x${"00".repeat(12)}${OTHER.slice(2)}`}), e)).toBeNull();
  });

  it("an intent that executes on another chain than the destination (CCTP, HyperCore, a second intent) is refused", () => {
    for (const chain of [8453n, 999n, 1n]) {
      expect(diamondCallMismatch(call({intentDestination: chain}), e)).toBe(`the Eco intent executes on chain ${chain}, not the destination 10 — a route whose delivery cannot be checked here`);
    }
  });

  it("the route's final transfer must move the destination token, to the recipient, at least the minimum shown", () => {
    const r = (calls: Call[]) => diamondCallMismatch(call({encodedRoute: route(calls)}), e);
    expect(r([transfer(OTHER, 990_000n)])).toBe(`the Eco route pays ${OTHER}, not ${RECEIVER}`);
    expect(r([transfer(RECEIVER, 990_000n), transfer(OTHER, 1n)])).toBe(`the Eco route pays ${OTHER}, not ${RECEIVER}`);
    expect(r([transfer(RECEIVER, 990_000n, OTHER)])).toBe(`the Eco route delivers ${OTHER}, not ${USDC_OP}`);
    expect(r([transfer(RECEIVER, 985_049n)])).toBe(`the Eco route delivers 985049, below the 985050 shown`);
    expect(r([transfer(RECEIVER, 985_050n)])).toBeNull();
  });

  it("a route that does not end in a plain token transfer, or makes no calls, is refused", () => {
    const r = (calls: Call[]) => diamondCallMismatch(call({encodedRoute: route(calls)}), e);
    expect(r([])).toBe("the Eco route makes no calls on the destination chain");
    expect(r([{target: USDC_OP as Hex, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [RECEIVER as Hex, 990_000n]}), value: 0n}])).toBe("the Eco route does not end in a token transfer");
    expect(r([{...transfer(RECEIVER, 990_000n), value: 1n}])).toBe("the Eco route does not end in a token transfer");
    expect(r([{...transfer(RECEIVER, 990_000n), data: `${transfer(RECEIVER, 990_000n).data}00` as Hex}])).toBe("the Eco route does not end in a token transfer");
    expect(r([{target: RECEIVER as Hex, data: "0x", value: 990_000n}])).toBe("the Eco route does not end in a token transfer");
    expect(diamondCallMismatch(call({encodedRoute: "0x1234"}), e)).toMatch(/^the Diamond calldata does not decode/);
  });

  it("a route to the native token is refused outright: no transfer to read, and a transfer \"of\" the zero address does not match it", () => {
    const native = {...e, toToken: ZERO};
    const r = (calls: Call[]) => diamondCallMismatch(call({encodedRoute: route(calls)}), native);
    const why = "an Eco route to the native token cannot be checked here";
    expect(r([{target: RECEIVER as Hex, data: "0x", value: 990_000n}])).toBe(why);
    expect(r([transfer(RECEIVER, 990_000n, ZERO)])).toBe(why);
    expect(diamondCallMismatch(call({encodedRoute: route([transfer(RECEIVER, 990_000n, ZERO)])}, true), native)).toBe(why);
  });

  it("a route of more than 16 calls is refused with its own reason; 16 ending in the transfer still pass", () => {
    const approve: Call = {target: USDC_OP as Hex, data: encodeFunctionData({abi: ERC20, functionName: "approve", args: [OTHER as Hex, 1n]}), value: 0n};
    const r = (calls: Call[]) => diamondCallMismatch(call({encodedRoute: route(calls)}), e);
    expect(r([...Array<Call>(15).fill(approve), transfer(RECEIVER, 990_000n)])).toBeNull();
    expect(r([...Array<Call>(16).fill(approve), transfer(RECEIVER, 990_000n)])).toBe("the Eco route makes 17 calls on the destination chain, more than the 16 read here");
    expect(r([...Array<Call>(40).fill(approve), transfer(RECEIVER, 990_000n)])).toBe("the Eco route makes 41 calls on the destination chain, more than the 16 read here");
  });
});
