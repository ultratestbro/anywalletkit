// Two request options from LI.FI's API (docs.li.fi/openapi.yaml, 2026-11-04).
// 1. `allowDestinationCall` (default true): the routes canary's Base ETH → Arbitrum ETH quote of 2026-11-04 09:37 came
//    back as a bridge with BridgeData.hasDestinationCall set, which the Diamond check refuses (the recipient sits in
//    calldata for the other chain), so the corridor showed no route. Cross-chain requests from an EVM chain now ask
//    LI.FI not to offer such routes (`allowDestinationCall=false` on /quote, `options.allowDestinationCall: false` on
//    /advanced/routes); the Diamond check stays as the backstop. A Solana source is unchanged.
// 2. `slippageScope=route` (opt-in, October 2026 changelog): one slippage budget for the whole route instead of one per
//    step. Behind `routeWideSlippage` (default off), EVM → EVM only; when LI.FI can protect no route it is asked again
//    in its default scope.
import {afterEach, describe, expect, it, vi} from "vitest";
import {diamondCallMismatch} from "../src/calldata.js";
import {lifiProvider} from "../src/provider.js";
import {PARAMS, RECIPIENT, response} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const SOLANA = {...PARAMS, sourceChain: "solana:mainnet", sourceToken: "SOL", refundAddress: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"};
const TO_SOLANA = {...PARAMS, destChain: "solana:mainnet", destToken: "0x0000000000000000000000000000000000000000", destAddress: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"};
const ROUTES = {routes: [{toAmount: "990000", toAmountMin: "985050", steps: [{tool: "across", estimate: {executionDuration: 5}}]}]};

/** Records every request; /advanced/routes answers ROUTES, /quote `quote(url)` (the fixture's answer by default). */
function record(quote: (url: URL) => Response = () => new Response(JSON.stringify(response()))) {
  const urls: URL[] = [];
  const bodies: {options?: Record<string, unknown>}[] = [];
  vi.stubGlobal("fetch", async (u: URL | string, init?: RequestInit) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith("/advanced/routes")) { bodies.push(JSON.parse(String(init!.body))); return new Response(JSON.stringify(ROUTES)); }
    urls.push(url);
    return quote(url);
  });
  return {urls, bodies};
}
const choose = () => ({allowBridges: ["across"]});

describe("watch 2026-11-04: allowDestinationCall=false on EVM-source cross-chain requests", () => {
  it("/quote carries allowDestinationCall=false from an EVM chain, and the quote still passes", async () => {
    const {urls} = record();
    expect(await lifiProvider().getQuote(PARAMS)).not.toBeNull();
    expect(urls[0]!.searchParams.getAll("allowDestinationCall")).toEqual(["false"]);
    // EVM → Solana too: the source is still a Diamond call.
    await lifiProvider().getQuote(TO_SOLANA);
    expect(urls[1]!.searchParams.getAll("allowDestinationCall")).toEqual(["false"]);
  });

  it("/advanced/routes options carry allowDestinationCall: false next to the deny list", async () => {
    const {bodies, urls} = record();
    expect(await lifiProvider({chooseRoute: choose}).getQuote(PARAMS)).not.toBeNull();
    expect(bodies[0]!.options).toMatchObject({allowDestinationCall: false, bridges: {deny: ["relaydepository", "garden", "squid", "symbiosis", "lifiIntents"]}});
    expect(urls[0]!.searchParams.getAll("allowDestinationCall")).toEqual(["false"]);
    expect(urls[0]!.searchParams.getAll("allowBridges")).toEqual(["across"]);
  });

  it("is not sent on a same-chain swap or from Solana (no Diamond call there to check)", async () => {
    const {urls, bodies} = record();
    await lifiProvider().getQuote({...PARAMS, destChain: PARAMS.sourceChain});
    await lifiProvider({chooseRoute: choose}).getQuote(SOLANA);
    expect(urls.map((u) => u.searchParams.has("allowDestinationCall"))).toEqual([false, false]);
    expect(bodies[0]!.options).not.toHaveProperty("allowDestinationCall");
  });

  it("a destination call LI.FI returns anyway is still refused by the Diamond check", async () => {
    const r = response();
    const data = r.transactionRequest.data;
    // BridgeData.hasDestinationCall: the 10th word of BridgeData, which starts after the (BridgeData, FacetData) head.
    const at = 2 + (4 + Number.parseInt(data.slice(10, 74), 16) + 32 * 9) * 2;
    const forged = `${data.slice(0, at)}${"0".repeat(63)}1${data.slice(at + 64)}`;
    expect(diamondCallMismatch(data, {fromToken: r.action.fromToken.address, toToken: r.action.toToken.address, amountIn: 1_000_000n, receiver: RECIPIENT, sender: r.action.fromAddress, minOut: 985_050n, destChainId: 42161n, sameChain: false, evmDestination: true})).toBeNull();
    record(() => new Response(JSON.stringify({...r, transactionRequest: {...r.transactionRequest, data: forged}})));
    const reasons: string[] = [];
    expect(await lifiProvider().getQuote({...PARAMS, onRefusal: (x) => reasons.push(x)})).toBeNull();
    expect(reasons).toEqual(["lifi: the transaction does not match the quote: the route runs a call on the destination chain, whose recipient cannot be checked here"]);
  });
});

describe("watch 2026-11-04: routeWideSlippage sends slippageScope=route on EVM → EVM requests (opt-in)", () => {
  it("off by default: neither /quote nor /advanced/routes carries slippageScope", async () => {
    const {urls, bodies} = record();
    expect(await lifiProvider({chooseRoute: choose}).getQuote(PARAMS)).not.toBeNull();
    await lifiProvider({routeWideSlippage: false}).getQuote(PARAMS);
    expect(urls.map((u) => u.searchParams.has("slippageScope"))).toEqual([false, false]);
    expect(bodies[0]!.options).not.toHaveProperty("slippageScope");
  });

  it("on: /quote and the routes options ask for route scope, cross-chain and same-chain EVM; the slippage itself is unchanged", async () => {
    const {urls, bodies} = record();
    expect(await lifiProvider({routeWideSlippage: true, chooseRoute: choose}).getQuote(PARAMS)).not.toBeNull();
    expect(bodies[0]!.options).toMatchObject({slippage: 0.005, slippageScope: "route"});
    expect(urls[0]!.searchParams.get("slippageScope")).toBe("route");
    expect(urls[0]!.searchParams.get("slippage")).toBe("0.005");
    await lifiProvider({routeWideSlippage: true}).getQuote({...PARAMS, destChain: PARAMS.sourceChain});
    expect(urls[1]!.searchParams.get("slippageScope")).toBe("route");
  });

  it("on: not sent when the route starts or ends on Solana (LI.FI covers EVM routes only)", async () => {
    const {urls, bodies} = record();
    await lifiProvider({routeWideSlippage: true, chooseRoute: choose}).getQuote(SOLANA);
    await lifiProvider({routeWideSlippage: true}).getQuote(TO_SOLANA);
    expect(urls.map((u) => u.searchParams.has("slippageScope"))).toEqual([false, false]);
    expect(bodies[0]!.options).not.toHaveProperty("slippageScope");
  });

  it("on: when LI.FI can protect no route (404 ROUTE_SLIPPAGE_UNSUPPORTED) or has the feature off (422 ROUTE_SLIPPAGE_UNAVAILABLE) it is asked once more in its default scope", async () => {
    const unsupported = {message: "No available quotes for the requested transfer", code: 1002, errors: {filteredOut: [{tool: "across", reason: "ROUTE_SLIPPAGE_UNSUPPORTED: the route has a destination swap"}]}};
    const {urls} = record((url) => url.searchParams.get("slippageScope") === "route" ? new Response(JSON.stringify(unsupported), {status: 404}) : new Response(JSON.stringify(response())));
    expect(await lifiProvider({routeWideSlippage: true}).getQuote(PARAMS)).not.toBeNull();
    expect(urls.map((u) => u.searchParams.get("slippageScope"))).toEqual(["route", null]);
    // LI.FI's other documented reason for the same case: route-wide slippage switched off (422, code 1004, in `message`).
    const off = {message: "ROUTE_SLIPPAGE_UNAVAILABLE: route-wide slippage is switched off", code: 1004};
    const third = record((url) => url.searchParams.get("slippageScope") === "route" ? new Response(JSON.stringify(off), {status: 422}) : new Response(JSON.stringify(response())));
    expect(await lifiProvider({routeWideSlippage: true}).getQuote(PARAMS)).not.toBeNull();
    expect(third.urls.map((u) => u.searchParams.get("slippageScope"))).toEqual(["route", null]);
    // Any other refusal is the answer, not a reason to drop the scope.
    const other = {message: "ROUTE_SLIPPAGE_FLOOR_UNREACHABLE: no quote reaches the floor", code: 1007};
    const second = record(() => new Response(JSON.stringify(other), {status: 404}));
    const reasons: string[] = [];
    expect(await lifiProvider({routeWideSlippage: true}).getQuote({...PARAMS, onRefusal: (x) => reasons.push(x)})).toBeNull();
    expect(second.urls.map((u) => u.searchParams.get("slippageScope"))).toEqual(["route"]);
    expect(reasons).toEqual(["lifi: ROUTE_SLIPPAGE_FLOOR_UNREACHABLE: no quote reaches the floor"]);
  });
});
