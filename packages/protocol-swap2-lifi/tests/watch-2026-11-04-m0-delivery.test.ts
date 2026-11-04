// M0 (li.quest/v1/tools bridge "m0", new on 2026-11-04's watch; M0Facet v1.0.0): an order on the M0 OrderBook asks a
// solver for `amountOut` of `tokenOut` on the destination chain. The facet ties only the receiver to BridgeData — the
// asset and the amount the solver must deliver were LI.FI's word. M0Data is static (receiverAddress, refundRecipient,
// orderOwner, tokenOut, solver, amountOut, fillDeadline), so both are read from the calldata and held to the quote:
// tokenOut is the destination token, amountOut at least the reviewed minimum. On the swap entry point the facet scales
// amountOut by the swap's realised output over the quoted input (≥ 1×), so the calldata's value is a lower bound.
// fixtures-live-2026-11-02-refunds.json: a live Ethereum USDC → Arbitrum USDC quote with allowBridges=m0 (amountOut =
// toAmountMin exactly).
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, parseAbi, type Abi, type Hex} from "viem";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {diamondCallMismatch, type DiamondExpectation} from "../src/calldata.js";
import {lifiProvider, lifiVerifyQuote} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

const B = "(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)";
const S = "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[]";
const M0 = "(bytes32 receiverAddress, address refundRecipient, address orderOwner, bytes32 tokenOut, bytes32 solver, uint128 amountOut, uint32 fillDeadline)";
const ABI: Abi = parseAbi([
  `function startBridgeTokensViaM0(${B} _bridgeData, ${M0} _m0Data)`,
  `function swapAndStartBridgeTokensViaM0(${B} _bridgeData, ${S} _swapData, ${M0} _m0Data)`,
] as readonly string[]);
type M0Data = {receiverAddress: Hex; refundRecipient: Hex; orderOwner: Hex; tokenOut: Hex; solver: Hex; amountOut: bigint; fillDeadline: number};
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

type Body = {action: {fromAddress: string; toAddress: string; fromAmount: string; fromToken: {address: string}; toToken: {address: string}}; estimate: {toAmountMin: string}; transactionRequest: {data: Hex}};
const fixture = JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-02-refunds.json", import.meta.url), "utf8")) as {corridors: {tool: string; response: Body}[]};
const live = fixture.corridors.find((c) => c.tool === "m0")!.response;
const USDC_ARB = live.action.toToken.address;
const OTHER = "0x9999999999999999999999999999999999999999";
const params: QuoteParams = {
  sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:42161", destToken: USDC_ARB, amountIn: live.action.fromAmount,
  destAddress: live.action.toAddress, refundAddress: live.action.fromAddress, slippageBps: 100,
};
const e: DiamondExpectation = {
  fromToken: live.action.fromToken.address, toToken: USDC_ARB, amountIn: BigInt(live.action.fromAmount), receiver: live.action.toAddress,
  sender: live.action.fromAddress, minOut: BigInt(live.estimate.toAmountMin), destChainId: 42161n, sameChain: false, evmDestination: true,
};
const decoded = decodeFunctionData({abi: ABI, data: live.transactionRequest.data});
const m0 = decoded.args!.at(-1) as M0Data;
const forge = (patch: Partial<M0Data>) => {
  const args = [...decoded.args!];
  args[args.length - 1] = {...m0, ...patch};
  return encodeFunctionData({abi: ABI, functionName: decoded.functionName, args: args as never});
};

describe("watch 2026-11-04: an M0 order's tokenOut and amountOut are held to the quote", () => {
  it("the live m0 quote passes: tokenOut is the destination USDC, amountOut the quote's minimum", () => {
    expect(decoded.functionName).toBe("swapAndStartBridgeTokensViaM0");
    expect(m0.tokenOut).toBe(pad(USDC_ARB));
    expect(m0.amountOut).toBe(e.minOut);
    expect(diamondCallMismatch(live.transactionRequest.data, e)).toBeNull();
  });

  it("a forged amountOut under the minimum, or another tokenOut, is refused (both entry points)", () => {
    expect(diamondCallMismatch(forge({amountOut: e.minOut - 1n}), e)).toBe(`the M0 order asks for ${e.minOut - 1n}, below the ${e.minOut} shown`);
    expect(diamondCallMismatch(forge({amountOut: 1n}), e)).toBe(`the M0 order asks for 1, below the ${e.minOut} shown`);
    expect(diamondCallMismatch(forge({tokenOut: pad(OTHER)}), e)).toBe(`the M0 order asks for ${OTHER}, not ${USDC_ARB}`);
    // The facet refuses a tokenOut with high bytes set on an EVM destination; here it does not decode.
    expect(diamondCallMismatch(forge({tokenOut: `0x01${pad(USDC_ARB).slice(4)}`}), e)).toMatch(/does not decode \(not an address\)/);
    expect(diamondCallMismatch(forge({amountOut: e.minOut + 1n}), e)).toBeNull();
    const start = encodeFunctionData({abi: ABI, functionName: "startBridgeTokensViaM0", args: [{...(decoded.args![0] as object), hasSourceSwaps: false, minAmount: e.amountIn, sendingAssetId: e.fromToken}, {...m0, amountOut: e.minOut - 1n}] as never});
    expect(diamondCallMismatch(start, e)).toBe(`the M0 order asks for ${e.minOut - 1n}, below the ${e.minOut} shown`);
  });

  it("an order for the native token is refused, even when tokenOut is zero to match it (M0Facet refuses that too)", () => {
    const ZERO = "0x0000000000000000000000000000000000000000";
    const native = {...e, toToken: ZERO};
    expect(diamondCallMismatch(forge({tokenOut: pad(ZERO)}), native)).toBe("an M0 order cannot deliver the native token");
    expect(diamondCallMismatch(live.transactionRequest.data, native)).toBe("an M0 order cannot deliver the native token");
  });

  it("the provider and the remote pin refuse the live quote with amountOut lowered", async () => {
    const replay = (data: Hex) => vi.stubGlobal("fetch", async (u: URL) => new Response(JSON.stringify({
      ...live, action: {...live.action, slippage: Number(new URL(String(u)).searchParams.get("slippage"))}, transactionRequest: {...live.transactionRequest, data},
    })));
    replay(live.transactionRequest.data);
    const honest = await lifiProvider().getQuote(params);
    expect(honest).not.toBeNull();
    expect(lifiVerifyQuote(params, honest!)).toBeNull();

    const forged = forge({amountOut: e.minOut / 2n});
    replay(forged);
    const reasons: string[] = [];
    expect(await lifiProvider().getQuote({...params, onRefusal: (r) => reasons.push(r)})).toBeNull();
    expect(reasons).toEqual([`lifi: the transaction does not match the quote: the M0 order asks for ${e.minOut / 2n}, below the ${e.minOut} shown`]);
    const tampered = {...honest!, txRequest: {...honest!.txRequest!, data: forged}} as Quote;
    expect(lifiVerifyQuote(params, tampered)).toMatch(/^the transaction does not match the request: the M0 order asks for/);
  });
});
