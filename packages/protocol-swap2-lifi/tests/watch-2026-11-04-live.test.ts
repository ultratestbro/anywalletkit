// fixtures-live-2026-11-04.json: public li.quest/v1/quote answers of 2026-11-04 (no API key), requested by the built
// provider: Base ETH → Arbitrum ETH with allowDestinationCall=false (the canary corridor that showed no route at
// 09:37), two EVM requests with routeWideSlippage on (slippageScope=route: a bridge and a same-chain swap), and an
// Ethereum USDC → Arbitrum USDC M0 order (allowBridges=m0). `ecoDisabled` records why no live Eco v3 call could be
// captured: LI.FI answered "Tool eco is currently disabled for this action." for every single-step Eco path.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, parseAbi, type Abi, type Hex} from "viem";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {lifiProvider, lifiVerifyQuote, type LifiProviderConfig} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

type Body = {tool: string; estimate: {toAmountMin: string}; routeSlippage?: {minimumToAmount: string; settlement: string}; transactionRequest: {data: Hex}};
type Corridor = {name: string; config: {routeWideSlippage?: boolean}; request: string; params: QuoteParams; response: Body};
const live = JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-04.json", import.meta.url), "utf8")) as {corridors: Corridor[]; ecoDisabled: {status: number; reasons: string[]}[]};
const corridor = (name: string) => live.corridors.find((c) => c.name === name)!;

/** Replays the recorded answer and returns the request the provider made. */
async function replay(c: Corridor, config: LifiProviderConfig = c.config, body: Body = c.response) {
  const urls: URL[] = [];
  vi.stubGlobal("fetch", async (u: URL | string) => { urls.push(new URL(String(u))); return new Response(JSON.stringify(body)); });
  const reasons: string[] = [];
  const quote = await lifiProvider({integrator: "awk-probe", ...config}).getQuote({...c.params, onRefusal: (r) => reasons.push(r)});
  return {quote, reasons, url: urls.at(-1)!};
}

describe("watch 2026-11-04: live LI.FI answers", () => {
  it("Base ETH → Arbitrum ETH, asked without destination calls: LI.FI's pick bridges straight to the recipient and passes", async () => {
    const c = corridor("base-eth>arb-eth");
    expect(new URL(c.request, "https://li.quest/v1/").searchParams.get("allowDestinationCall")).toBe("false");
    const {quote, reasons, url} = await replay(c);
    expect(reasons).toEqual([]);
    expect(url.searchParams.get("allowDestinationCall")).toBe("false");
    expect(lifiVerifyQuote(c.params, quote!)).toBeNull();
    // BridgeData.hasDestinationCall, the 10th word of BridgeData.
    const data = c.response.transactionRequest.data;
    const at = 2 + (4 + Number.parseInt(data.slice(10, 74), 16) + 32 * 9) * 2;
    expect(BigInt(`0x${data.slice(at, at + 64)}`)).toBe(0n);
  });

  it("slippageScope=route: LI.FI returns one floor (routeSlippage.minimumToAmount = toAmountMin), and the quote passes on it", async () => {
    for (const [name, settlement] of [["base-usdc>op-usdc route-scope", "conditional"], ["base-usdc>base-eth route-scope", "atomic"]] as const) {
      const c = corridor(name);
      expect(new URL(c.request, "https://li.quest/v1/").searchParams.get("slippageScope")).toBe("route");
      expect(c.response.routeSlippage).toMatchObject({minimumToAmount: c.response.estimate.toAmountMin, settlement});
      const {quote, reasons, url} = await replay(c);
      expect([name, reasons]).toEqual([name, []]);
      expect(url.searchParams.get("slippageScope")).toBe("route");
      expect(quote!.minDestAmount).toBe(c.response.routeSlippage!.minimumToAmount);
      expect(lifiVerifyQuote(c.params, quote!)).toBeNull();
    }
  });

  it("M0: the live order asks for the destination USDC and the quote's minimum; lowered, it is refused", async () => {
    const c = corridor("eth-usdc>arb-usdc m0");
    expect(c.response.tool).toBe("m0");
    const {quote, reasons} = await replay(c);
    expect(reasons).toEqual([]);
    expect(lifiVerifyQuote(c.params, quote!)).toBeNull();
    const M0 = "(bytes32 receiverAddress, address refundRecipient, address orderOwner, bytes32 tokenOut, bytes32 solver, uint128 amountOut, uint32 fillDeadline)";
    const abi: Abi = parseAbi([
      `function swapAndStartBridgeTokensViaM0((bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall) _bridgeData, (address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[] _swapData, ${M0} _m0Data)`,
    ] as readonly string[]);
    const decoded = decodeFunctionData({abi, data: c.response.transactionRequest.data});
    const args = [...decoded.args!];
    const m0 = args[2] as {amountOut: bigint; tokenOut: Hex};
    expect(m0.amountOut).toBe(BigInt(c.response.estimate.toAmountMin));
    args[2] = {...m0, amountOut: m0.amountOut - 1n};
    const forged = encodeFunctionData({abi, functionName: decoded.functionName, args: args as never});
    const refused = await replay(c, c.config, {...c.response, transactionRequest: {...c.response.transactionRequest, data: forged}});
    expect(refused.quote).toBeNull();
    expect(refused.reasons).toEqual([`lifi: the transaction does not match the quote: the M0 order asks for ${m0.amountOut - 1n}, below the ${m0.amountOut} shown`]);
  });

  it("no live Eco call could be recorded: LI.FI had Eco disabled for every single-step path asked", () => {
    expect(live.ecoDisabled.length).toBeGreaterThanOrEqual(3);
    for (const e of live.ecoDisabled) {
      expect(e.status).toBe(404);
      expect(e.reasons).toContain("Tool eco is currently disabled for this action.");
    }
  });
});
