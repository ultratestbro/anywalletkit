// The Diamond check compared BridgeData's receiver, chain, asset and amounts, but never the refund, depositor or
// fallback addresses a facet carries in its own data — LayerZero's unused native fee (Stargate), the whole input of an
// expired Across deposit, LI.FI intent, Eco intent, M0 order or Mayan Swift order, Chainflip's refund on a missed
// minimum price, Superset's fallback. The facets only require them to be non-zero, so an API (or an `apiUrl` proxy)
// could name any address there and every other check stayed green. Each one must now be the sender or the recipient.
// Live evidence: every recorded LI.FI quote (2026-10-28, 10-30, 11-02, and 2026-11-02 quotes with the bridge forced:
// M0, Frax, Superset, Symbiosis, Squid) sets them to the sender — except Superset, which names a third address. (Squid
// and Symbiosis are refused outright since: audit-2026-11-02-r5-squid-symbiosis.test.ts.)
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type Abi, type Hex} from "viem";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {diamondCallMismatch, type DiamondExpectation} from "../src/calldata.js";
import {lifiProvider, lifiVerifyQuote} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

const SENDER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const RECEIVER = "0x3333333333333333333333333333333333333333";
const OTHER = "0x9999999999999999999999999999999999999999";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const word = (v: bigint | string) => (typeof v === "bigint" ? v.toString(16) : v.slice(2)).padStart(64, "0");

const B = "(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)";
const S = "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[]";
// Facet data as lifinance/contracts declares it (Eco as at v3.0.0, 9001792, whose entry points the Diamond check lists).
const FACETS: Record<string, string> = {
  AcrossV4: "(bytes32 receiverAddress, bytes32 refundAddress, bytes32 sendingAssetId, bytes32 receivingAssetId, uint256 outputAmount, uint128 outputAmountMultiplier, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)",
  AcrossV4Swap: "(uint8 swapApiTarget, bytes callData, bytes signature)",
  ArbitrumBridge: "(uint256 maxSubmissionCost, uint256 maxGas, uint256 maxGasPrice)",
  Centrifuge: "(uint256 nativeFee, address refundRecipient)",
  Chainflip: `(bytes nonEVMReceiver, uint32 dstToken, address dstCallReceiver, ${S} dstCallSwapData, uint256 gasAmount, bytes cfParameters)`,
  Eco: "(bytes nonEVMReceiver, address prover, uint64 rewardDeadline, uint64 intentDestination, bytes encodedRoute, bytes32 solanaATA, address refundRecipient, uint256 deadline, bytes signature)",
  Frax: "(address oft, uint32 dstEid, uint256 nativeFee, address refundRecipient, bytes32 nonEVMReceiver)",
  Glacis: "(bytes32 receiverAddress, address refundAddress, uint256 nativeFee, bytes32 outputToken)",
  LayerSwap: "(bytes32 requestId, address depositoryReceiver, address refundRecipient, bytes32 nonEVMReceiver, bytes signature, uint256 deadline)",
  LiFiIntentEscrowV2: `(bytes32 dstCallReceiver, bytes32 recipient, address depositAndRefundAddress, uint256 nonce, uint32 expires, uint32 fillDeadline, address inputOracle, bytes32 outputOracle, bytes32 outputSettler, bytes32 outputToken, uint128 outputAmountMultiplier, ${S} dstCallSwapData, bytes outputContext)`,
  M0: "(bytes32 receiverAddress, address refundRecipient, address orderOwner, bytes32 tokenOut, bytes32 solver, uint128 amountOut, uint32 fillDeadline)",
  Mayan: "(bytes32 nonEVMReceiver, address mayanProtocol, bytes protocolData, address swapProtocol, bytes swapData, address middleToken, uint256 minMiddleAmount, address refundRecipient, uint256 mayanAmountIn)",
  NEARIntents: "(bytes32 nonEVMReceiver, bytes32 destinationAsset, address depositAddress, bytes32 quoteId, uint256 deadline, uint256 minAmountOut, address refundRecipient, bytes signature)",
  PolymerCCTP: "(uint256 polymerTokenFee, uint256 maxCCTPFee, bytes32 nonEVMReceiver, bytes32 solanaReceiverATA, uint32 minFinalityThreshold, address refundRecipient, bytes hookData)",
  Squid: "(uint8 routeType, string destinationChain, string destinationAddress, string bridgedTokenSymbol, address depositAssetId, (uint8 callType, address target, uint256 value, bytes callData, bytes payload)[] sourceCalls, bytes payload, uint256 fee, bool enableExpress)",
  Stargate: "(uint16 assetId, (uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParams, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress)",
  Superset: "(bytes path, uint256 amountOutMin, address refundAddress, address fallbackEoA, uint256 deadline, uint32 toEid, bytes options, uint256 lzFee)",
  Symbiosis: "(address refundRecipient, bytes32 nonEvmReceiver, bytes firstSwapCalldata, bytes secondSwapCalldata, address firstDexRouter, address secondDexRouter, address[] approvedTokens, address callTo, bytes callData, bool viaOnchainSwapV3, address dex, address dexgateway, bytes onchainSwapData, uint256 fee, uint256 deadline, bytes signature)",
};
const ABI: Abi = parseAbi(Object.entries(FACETS).flatMap(([k, t]) => [
  `function startBridgeTokensVia${k}(${B} _bridgeData, ${t} _facetData)`,
  `function swapAndStartBridgeTokensVia${k}(${B} _bridgeData, ${S} _swapData, ${t} _facetData)`,
]) as readonly string[]);
/** The refund-like fields of each facet's data, as the check reads them. LI.FI Intents (`depositAndRefundAddress`) is
 * refused before its refund field is read since 2026-11-13 (its oracles and settler are not pinned): see below. */
const REFUND_FIELDS: Record<string, string[]> = {
  AcrossV4: ["refundAddress"], Centrifuge: ["refundRecipient"], Eco: ["refundRecipient"], Frax: ["refundRecipient"], Glacis: ["refundAddress"],
  LayerSwap: ["refundRecipient"], M0: ["refundRecipient", "orderOwner"], Mayan: ["refundRecipient"],
  NEARIntents: ["refundRecipient"], PolymerCCTP: ["refundRecipient"], Stargate: ["refundAddress"], Superset: ["refundAddress", "fallbackEoA"],
};
const BYTES32_FIELDS = new Set(["AcrossV4.refundAddress"]);
const INTENTS_UNPINNED = "a LI.FI Intents order to an EVM chain names its own oracles, output settler and output amount, which cannot be checked here — its escrow could release the input without the delivery";

type Facet = Record<string, unknown>;
const bridgeData = (sourceSwaps = false) => ({
  transactionId: ZERO32, bridge: "x", integrator: "awk", referrer: ZERO as Hex, sendingAssetId: USDC as Hex, receiver: RECEIVER as Hex,
  minAmount: 1_000_000n, destinationChainId: 42161n, hasSourceSwaps: sourceSwaps, hasDestinationCall: false,
});
const feeStep = [{callTo: OTHER as Hex, approveTo: OTHER as Hex, sendingAssetId: USDC as Hex, receivingAssetId: USDC as Hex, fromAmount: 1_000_000n, callData: "0x" as Hex, requiresDeposit: true}];
const call = (facet: string, data: Facet, sourceSwaps = false) => encodeFunctionData({
  abi: ABI, functionName: `${sourceSwaps ? "swapAndStart" : "start"}BridgeTokensVia${facet}`,
  args: (sourceSwaps ? [bridgeData(true), feeStep, data] : [bridgeData(), data]) as never,
});
const expectation: DiamondExpectation = {fromToken: USDC, toToken: USDC, amountIn: 1_000_000n, receiver: RECEIVER, sender: SENDER, minOut: 1n, destChainId: 42161n, sameChain: false, evmDestination: true};

/** Mayan protocolData: the selector, then words with `refund` at `refundWord` (the facet reads the receiver at its own offset). */
const mayanProtocol = (selector: string, refundWord: number, refund: string, receiverWord: number) =>
  `0x${selector.slice(2)}${Array.from({length: 16}, (_, i) => word(i === refundWord ? pad(refund) : i === receiverWord ? pad(RECEIVER) : 0n)).join("")}` as Hex;
/** An Eco route (abi.encode(Route)) whose one call transfers the destination USDC to the recipient. */
const ecoRoute = () => encodeAbiParameters(parseAbiParameters("(bytes32 salt, uint64 deadline, address portal, uint256 nativeAmount, (address token, uint256 amount)[] tokens, (address target, bytes data, uint256 value)[] calls)"),
  [{salt: ZERO32, deadline: 1n, portal: OTHER, nativeAmount: 0n, tokens: [{token: USDC, amount: 1n}], calls: [{target: USDC, data: encodeFunctionData({abi: parseAbi(["function transfer(address, uint256)"]), args: [RECEIVER, 1n]}), value: 0n}]}]);
const chainflipParams = (refund: string, version = "01") => `0x${version}64000000${refund.slice(2)}${"00".repeat(40)}` as Hex;

// Honest facet data for each facet: every refund-like field the sender (Superset's fallback the recipient).
const SAMPLES: Record<string, Facet> = {
  AcrossV4: {receiverAddress: pad(RECEIVER), refundAddress: pad(SENDER), sendingAssetId: pad(USDC), receivingAssetId: pad(USDC), outputAmount: 990_000n, outputAmountMultiplier: 0n, exclusiveRelayer: ZERO32, quoteTimestamp: 1, fillDeadline: 2, exclusivityParameter: 0, message: "0x"},
  Centrifuge: {nativeFee: 0n, refundRecipient: SENDER},
  Eco: {nonEVMReceiver: "0x", prover: OTHER, rewardDeadline: 1n, intentDestination: 42161n, encodedRoute: ecoRoute(), solanaATA: ZERO32, refundRecipient: SENDER, deadline: 1n, signature: "0x"},
  Frax: {oft: OTHER, dstEid: 30110, nativeFee: 0n, refundRecipient: SENDER, nonEVMReceiver: ZERO32},
  Glacis: {receiverAddress: pad(RECEIVER), refundAddress: SENDER, nativeFee: 0n, outputToken: ZERO32},
  LayerSwap: {requestId: ZERO32, depositoryReceiver: OTHER, refundRecipient: SENDER, nonEVMReceiver: ZERO32, signature: "0x", deadline: 1n},
  LiFiIntentEscrowV2: {dstCallReceiver: ZERO32, recipient: pad(RECEIVER), depositAndRefundAddress: SENDER, nonce: 1n, expires: 1, fillDeadline: 1, inputOracle: OTHER, outputOracle: ZERO32, outputSettler: ZERO32, outputToken: ZERO32, outputAmountMultiplier: 0n, dstCallSwapData: [], outputContext: "0x"},
  M0: {receiverAddress: pad(RECEIVER), refundRecipient: SENDER, orderOwner: SENDER, tokenOut: pad(USDC), solver: ZERO32, amountOut: 1n, fillDeadline: 1},
  Mayan: {nonEVMReceiver: pad(RECEIVER), mayanProtocol: OTHER, protocolData: mayanProtocol("0xa3a30834", 3, SENDER, 4), swapProtocol: ZERO, swapData: "0x", middleToken: ZERO, minMiddleAmount: 0n, refundRecipient: SENDER, mayanAmountIn: 1_000_000n},
  NEARIntents: {nonEVMReceiver: ZERO32, destinationAsset: ZERO32, depositAddress: OTHER, quoteId: ZERO32, deadline: 1n, minAmountOut: 1n, refundRecipient: SENDER, signature: "0x"},
  PolymerCCTP: {polymerTokenFee: 0n, maxCCTPFee: 0n, nonEVMReceiver: ZERO32, solanaReceiverATA: ZERO32, minFinalityThreshold: 2000, refundRecipient: SENDER, hookData: "0x"},
  Stargate: {assetId: 1, sendParams: {dstEid: 30110, to: pad(RECEIVER), amountLD: 0n, minAmountLD: 0n, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x"}, fee: {nativeFee: 0n, lzTokenFee: 0n}, refundAddress: SENDER},
  Superset: {path: "0x", amountOutMin: 1n, refundAddress: SENDER, fallbackEoA: RECEIVER, deadline: 1n, toEid: 30110, options: "0x", lzFee: 0n},
  Chainflip: {nonEVMReceiver: "0x", dstToken: 3, dstCallReceiver: ZERO, dstCallSwapData: [], gasAmount: 0n, cfParameters: chainflipParams(SENDER)},
};

describe("audit 2026-11-02 r5: a bridge facet's refund and fallback addresses are the sender's or the recipient's", () => {
  it("every facet with a refund field: honest data passes (both entry points), each field set to another address is refused", () => {
    for (const [facet, fields] of Object.entries(REFUND_FIELDS)) {
      for (const swaps of [false, true]) {
        expect([facet, swaps, diamondCallMismatch(call(facet, SAMPLES[facet]!, swaps), expectation)]).toEqual([facet, swaps, null]);
        for (const field of fields) {
          const forged = {...SAMPLES[facet], [field]: BYTES32_FIELDS.has(`${facet}.${field}`) ? pad(OTHER) : OTHER};
          expect([facet, field, swaps, diamondCallMismatch(call(facet, forged, swaps), expectation)])
            .toEqual([facet, field, swaps, `${facet} ${field} pays ${OTHER}, neither the sender ${SENDER} nor the recipient`]);
        }
      }
    }
    // The recipient is an acceptable refund address too (Superset's fallback above); a dirty bytes32 does not decode.
    expect(diamondCallMismatch(call("Stargate", {...SAMPLES.Stargate, refundAddress: RECEIVER}), expectation)).toBeNull();
    expect(diamondCallMismatch(call("AcrossV4", {...SAMPLES.AcrossV4, refundAddress: `0x01${pad(SENDER).slice(4)}`}), expectation)).toMatch(/does not decode \(not an address\)/);
  });

  it("LI.FI Intents between EVM chains is refused before its refund address is read: honest, forged or zero, both entry points", () => {
    for (const swaps of [false, true]) {
      for (const refund of [SENDER, RECEIVER, OTHER, ZERO]) {
        const data = call("LiFiIntentEscrowV2", {...SAMPLES.LiFiIntentEscrowV2, depositAndRefundAddress: refund}, swaps);
        expect([swaps, refund, diamondCallMismatch(data, expectation)]).toEqual([swaps, refund, INTENTS_UNPINNED]);
      }
    }
  });

  it("a zero refund address passes only where the facet itself refuses a zero it would use (Polymer CCTP ignores it without swaps)", () => {
    for (const [facet, fields] of Object.entries(REFUND_FIELDS)) {
      if (facet === "Stargate") continue;
      for (const field of fields) {
        const zero = {...SAMPLES[facet], [field]: BYTES32_FIELDS.has(`${facet}.${field}`) ? ZERO32 : ZERO};
        expect([facet, field, diamondCallMismatch(call(facet, zero), expectation)]).toEqual([facet, field, null]);
      }
    }
    // Stargate hands its refund address to LayerZero unchecked; Mayan's trader and Chainflip's refund go into the protocol.
    expect(diamondCallMismatch(call("Stargate", {...SAMPLES.Stargate, refundAddress: ZERO}), expectation)).toBe(`Stargate refundAddress pays ${ZERO}, neither the sender ${SENDER} nor the recipient`);
    expect(diamondCallMismatch(call("Mayan", {...SAMPLES.Mayan, protocolData: mayanProtocol("0xa3a30834", 3, ZERO, 4)}), expectation)).toMatch(/^the Mayan order's refund address pays 0x0{40}/);
    expect(diamondCallMismatch(call("Chainflip", {...SAMPLES.Chainflip, cfParameters: chainflipParams(ZERO)}), expectation)).toMatch(/^the Chainflip refund address pays 0x0{40}/);
  });

  it("Chainflip: the refund address inside cfParameters (VersionedCfParameters V1) is checked; another version is refused", () => {
    expect(diamondCallMismatch(call("Chainflip", SAMPLES.Chainflip!), expectation)).toBeNull();
    expect(diamondCallMismatch(call("Chainflip", SAMPLES.Chainflip!, true), expectation)).toBeNull();
    expect(diamondCallMismatch(call("Chainflip", {...SAMPLES.Chainflip, cfParameters: chainflipParams(OTHER)}), expectation)).toBe(`the Chainflip refund address pays ${OTHER}, neither the sender ${SENDER} nor the recipient`);
    expect(diamondCallMismatch(call("Chainflip", {...SAMPLES.Chainflip, cfParameters: chainflipParams(SENDER, "00")}), expectation)).toMatch(/unknown Chainflip parameters/);
    expect(diamondCallMismatch(call("Chainflip", {...SAMPLES.Chainflip, cfParameters: "0x01"}), expectation)).toMatch(/unknown Chainflip parameters/);
  });

  it("Mayan: a Swift order's trader and a Wormhole swap's refundAddr inside protocolData are checked; MCTP carries none", () => {
    const m = (protocolData: Hex) => call("Mayan", {...SAMPLES.Mayan, protocolData});
    // [selector, refund word after the selector, receiver word the facet reads]
    const swift: [string, number, number][] = [["0xa3a30834", 3, 4], ["0x6147435b", 3, 4], ["0xb866e173", 0, 7], ["0x8e8d142b", 2, 9], ["0x6111ad25", 9, 6], ["0x1eb1cff0", 9, 6]];
    for (const [sel, at, rx] of swift) {
      expect([sel, diamondCallMismatch(m(mayanProtocol(sel, at, SENDER, rx)), expectation)]).toEqual([sel, null]);
      expect([sel, diamondCallMismatch(m(mayanProtocol(sel, at, OTHER, rx)), expectation)]).toEqual([sel, `the Mayan order's refund address pays ${OTHER}, neither the sender ${SENDER} nor the recipient`]);
    }
    // MayanCircle bridgeWithFee: no refund address in the order.
    expect(diamondCallMismatch(m(mayanProtocol("0x94454a5d", 9, OTHER, 4)), expectation)).toBeNull();
  });

  it("Across Swap API: the depositor of a SpokePool / periphery deposit and the sponsored flows' refundRecipient are checked", () => {
    const deposit = (depositor: string) => encodeAbiParameters(parseAbiParameters("(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)"),
      [{depositor: pad(depositor), recipient: pad(RECEIVER), inputToken: pad(USDC), outputToken: pad(USDC), inputAmount: 1_000_000n, outputAmount: 1n, destinationChainId: 42161n, exclusiveRelayer: ZERO32, quoteTimestamp: 1, fillDeadline: 1, exclusivityParameter: 0, message: "0x"}]);
    const periphery = (depositor: string) => encodeAbiParameters(parseAbiParameters("((uint256 amount, address recipient) submissionFees, (address inputToken, bytes32 outputToken, uint256 outputAmount, address depositor, bytes32 recipient, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) depositData, address swapToken, address exchange, uint8 transferType, uint256 swapTokenAmount, uint256 minExpectedInputTokenAmount, bytes routerCalldata, bool enableProportionalAdjustment, address spokePool, uint256 nonce)"),
      [{submissionFees: {amount: 0n, recipient: ZERO}, depositData: {inputToken: USDC, outputToken: pad(USDC), outputAmount: 1n, depositor: depositor as Hex, recipient: pad(RECEIVER), destinationChainId: 42161n, exclusiveRelayer: ZERO32, quoteTimestamp: 1, fillDeadline: 1, exclusivityParameter: 0, message: "0x"},
        swapToken: USDC, exchange: OTHER, transferType: 0, swapTokenAmount: 1_000_000n, minExpectedInputTokenAmount: 1n, routerCalldata: "0x", enableProportionalAdjustment: false, spokePool: OTHER, nonce: 0n}]);
    const oft = (refund: string) => encodeAbiParameters(parseAbiParameters("((uint32 srcEid, uint32 dstEid, bytes32 destinationHandler, uint256 amountLD, bytes32 nonce, uint256 deadline, uint256 maxBpsToSponsor, uint256 maxUserSlippageBps, bytes32 finalRecipient, bytes32 finalToken, uint32 destinationDex, uint256 lzReceiveGasLimit, uint256 lzComposeGasLimit, uint256 maxOftFeeBps, uint8 accountCreationMode, uint8 executionMode, bytes actionData) signedParams, (address refundRecipient) unsignedParams), bytes"),
      [{signedParams: {srcEid: 1, dstEid: 2, destinationHandler: ZERO32, amountLD: 1_000_000n, nonce: ZERO32, deadline: 1n, maxBpsToSponsor: 0n, maxUserSlippageBps: 0n, finalRecipient: pad(RECEIVER), finalToken: ZERO32, destinationDex: 0, lzReceiveGasLimit: 0n, lzComposeGasLimit: 0n, maxOftFeeBps: 0n, accountCreationMode: 0, executionMode: 0, actionData: "0x"}, unsignedParams: {refundRecipient: refund as Hex}}, "0x1234"]);
    const cctp = (refund: string) => encodeAbiParameters(parseAbiParameters("(uint32 sourceDomain, uint32 destinationDomain, bytes32 mintRecipient, uint256 amount, bytes32 burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes32 nonce, uint256 deadline, uint256 maxBpsToSponsor, uint256 maxUserSlippageBps, bytes32 finalRecipient, bytes32 finalToken, uint32 destinationDex, uint8 accountCreationMode, uint8 executionMode, bytes actionData), bytes, address"),
      [{sourceDomain: 6, destinationDomain: 3, mintRecipient: ZERO32, amount: 1_000_000n, burnToken: pad(USDC), destinationCaller: ZERO32, maxFee: 0n, minFinalityThreshold: 1000, nonce: ZERO32, deadline: 1n, maxBpsToSponsor: 0n, maxUserSlippageBps: 0n, finalRecipient: pad(RECEIVER), finalToken: ZERO32, destinationDex: 0, accountCreationMode: 0, executionMode: 0, actionData: "0x"}, "0x1234", refund as Hex]);
    const targets: [number, (a: string) => Hex, string][] = [[0, deposit, "the Across deposit's depositor"], [1, periphery, "the Across deposit's depositor"], [2, oft, "the sponsored OFT refund recipient"], [3, cctp, "the sponsored CCTP refund recipient"]];
    for (const [target, encode, what] of targets) {
      for (const swaps of [false, true]) {
        const swap = (to: string) => call("AcrossV4Swap", {swapApiTarget: target, callData: encode(to), signature: "0x"}, swaps);
        expect([target, swaps, diamondCallMismatch(swap(SENDER), expectation)]).toEqual([target, swaps, null]);
        expect([target, swaps, diamondCallMismatch(swap(OTHER), expectation)]).toEqual([target, swaps, `${what} pays ${OTHER}, neither the sender ${SENDER} nor the recipient`]);
        expect([target, swaps, diamondCallMismatch(swap(ZERO), expectation)]).toEqual([target, swaps, null]); // the facet refuses a zero
      }
    }
  });

  it("facets whose data names no one to pay back are unaffected (live Arbitrum bridge)", () => {
    const arb = live().find((l) => l.facet === "ArbitrumBridge")!;
    expect(arb).toBeDefined();
    expect(diamondCallMismatch(arb.data, arb.e)).toBeNull();
  });

  it("every recorded live quote passes; its refund fields (and a Mayan order's trader) set to another address are refused", () => {
    const seen = new Set<string>();
    let intents = 0;
    for (const l of live()) {
      if (l.facet === "LiFiIntentEscrowV2") {
        // Recorded LI.FI Intents calls between EVM chains (BSC USDT → Arbitrum USDC, OP ETH → Base ETH): refused outright.
        expect([l.name, diamondCallMismatch(l.data, l.e)]).toEqual([l.name, INTENTS_UNPINNED]);
        intents++;
        continue;
      }
      const fields = REFUND_FIELDS[l.facet];
      if (!fields) continue;
      seen.add(l.facet);
      const decoded = decodeFunctionData({abi: ABI, data: l.data});
      const args = [...decoded.args!] as unknown[];
      const facetData = args[args.length - 1] as Facet;
      if (l.facet === "Superset") {
        // Live Superset quotes name a third address (neither the sender, the recipient, the Diamond nor a LI.FI wallet).
        expect([l.name, diamondCallMismatch(l.data, l.e)]).toEqual([l.name, `Superset refundAddress pays ${String(facetData.refundAddress)}, neither the sender ${l.e.sender} nor the recipient`.replace(String(facetData.refundAddress), String(facetData.refundAddress).toLowerCase())]);
        continue;
      }
      expect([l.name, diamondCallMismatch(l.data, l.e)]).toEqual([l.name, null]);
      const forge = (patch: Facet) => {
        const a = [...args];
        a[a.length - 1] = {...facetData, ...patch};
        return encodeFunctionData({abi: ABI, functionName: decoded.functionName, args: a as never});
      };
      for (const field of fields) {
        const v = BYTES32_FIELDS.has(`${l.facet}.${field}`) ? pad(OTHER) : OTHER;
        expect([l.name, field, diamondCallMismatch(forge({[field]: v}), l.e)]).toEqual([l.name, field, `${l.facet} ${field} pays ${OTHER}, neither the sender ${l.e.sender} nor the recipient`]);
      }
      if (l.facet === "Mayan") {
        const p = String(facetData.protocolData);
        expect(p.slice(0, 10)).toBe("0xa3a30834"); // Swift v2: trader is the 4th word
        const trader = 10 + 64 * 3;
        expect(p.slice(trader, trader + 64)).toBe(pad(l.e.sender).slice(2));
        const forged = forge({protocolData: `${p.slice(0, trader)}${pad(OTHER).slice(2)}${p.slice(trader + 64)}`});
        expect(diamondCallMismatch(forged, l.e)).toBe(`the Mayan order's refund address pays ${OTHER}, neither the sender ${l.e.sender} nor the recipient`);
      }
    }
    expect([...seen].sort()).toEqual(["AcrossV4", "Frax", "Glacis", "LayerSwap", "M0", "Mayan", "NEARIntents", "PolymerCCTP", "Stargate", "Superset"]);
    expect(intents).toBe(2);
  });

  it("the provider and the remote pin refuse the recorded Stargate quote with LayerZero's refund address replaced", async () => {
    const c = oct30.corridors.find((k) => k.responses.some((r) => r.body?.tool === "stargateV2"))!;
    const body = c.responses.find((r) => r.body?.tool === "stargateV2")!.body as {transactionRequest: {data: Hex}};
    const decoded = decodeFunctionData({abi: ABI, data: body.transactionRequest.data});
    const args = [...decoded.args!] as unknown[];
    expect((args[2] as {refundAddress: string}).refundAddress.toLowerCase()).toBe(SENDER);
    args[2] = {...(args[2] as Facet), refundAddress: OTHER};
    const forged = encodeFunctionData({abi: ABI, functionName: decoded.functionName, args: args as never});
    const replay = (data: Hex) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify({...body, transactionRequest: {...body.transactionRequest, data}})));

    replay(body.transactionRequest.data);
    const honest = await lifiProvider({integrator: "awk-probe"}).getQuote(c.params);
    expect(honest).not.toBeNull();
    expect(lifiVerifyQuote(c.params, honest!)).toBeNull();

    replay(forged);
    const reasons: string[] = [];
    expect(await lifiProvider({integrator: "awk-probe"}).getQuote({...c.params, onRefusal: (r) => reasons.push(r)})).toBeNull();
    expect(reasons[0]).toBe(`lifi: the transaction does not match the quote: Stargate refundAddress pays ${OTHER}, neither the sender ${c.params.refundAddress} nor the recipient`);
    const tampered = {...honest!, txRequest: {...honest!.txRequest!, data: forged}} as Quote;
    expect(lifiVerifyQuote(c.params, tampered)).toMatch(/^the transaction does not match the request: Stargate refundAddress pays 0x9999/);
  });
});

type Corridor = {name: string; params: QuoteParams; responses: {status: number; body: Body | null}[]};
type Body = {tool?: string; action: {fromAddress: string; toAddress: string; fromAmount: string; fromChainId: number; toChainId: number; fromToken: {address: string}; toToken: {address: string}}; transactionRequest?: {data?: string}};
const read = <T>(name: string) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")) as T;
const oct28 = read<{quotes: {fromChainId: number; toChainId: number; fromToken: string; toToken: string; fromAmount: string; toAddress: string; tool: string; data: string}[]}>("fixtures-live-2026-10-28.json");
const oct30 = read<{corridors: Corridor[]}>("fixtures-live-2026-10-30.json");
const nov02 = read<{corridors: {name: string; response: Body}[]}>("fixtures-live-2026-11-02.json");
const forced = read<{corridors: {tool: string; response: Body}[]}>("fixtures-live-2026-11-02-refunds.json");

/** Every recorded EVM → EVM bridge call of a listed facet, with the expectation its quote implies. */
function live(): {name: string; facet: string; data: Hex; e: DiamondExpectation}[] {
  const out: {name: string; facet: string; data: Hex; e: DiamondExpectation}[] = [];
  const add = (name: string, data: string | undefined, a: {from: string; to: string; amount: string; fromChain: number; toChain: number; fromToken: string; toToken: string}) => {
    if (!data?.startsWith("0x") || a.fromChain === a.toChain || !/^0x[0-9a-fA-F]{40}$/.test(a.to)) return; // swaps; non-EVM destinations
    let fn: string;
    try { fn = decodeFunctionData({abi: ABI, data: data as Hex}).functionName; } catch { return; }
    out.push({name, facet: fn.replace(/^(swapAndStart|start)BridgeTokensVia/, ""), data: data as Hex, e: {
      fromToken: a.fromToken, toToken: a.toToken, amountIn: BigInt(a.amount), receiver: a.to, sender: a.from, minOut: 1n,
      destChainId: BigInt(a.toChain), sameChain: false, evmDestination: true,
    }});
  };
  const fromBody = (name: string, b: Body) => add(name, b.transactionRequest?.data, {
    from: b.action.fromAddress, to: b.action.toAddress, amount: b.action.fromAmount, fromChain: b.action.fromChainId, toChain: b.action.toChainId, fromToken: b.action.fromToken.address, toToken: b.action.toToken.address,
  });
  // 2026-10-28 was requested with fromAddress = toAddress.
  for (const q of oct28.quotes) add(`10-28 ${q.tool}`, q.data, {from: q.toAddress, to: q.toAddress, amount: q.fromAmount, fromChain: q.fromChainId, toChain: q.toChainId, fromToken: q.fromToken, toToken: q.toToken});
  for (const c of oct30.corridors) for (const r of c.responses) if (r.body?.action) fromBody(`10-30 ${c.name}`, r.body);
  for (const c of nov02.corridors) if (c.response?.action) fromBody(`11-02 ${c.name}`, c.response);
  for (const c of forced.corridors) fromBody(`11-02 forced ${c.tool}`, c.response);
  return out;
}
