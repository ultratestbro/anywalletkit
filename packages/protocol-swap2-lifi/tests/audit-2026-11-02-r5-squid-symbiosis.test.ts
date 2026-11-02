// Squid and Symbiosis do not tie where the funds go to BridgeData.receiver either. Squid's CallBridge route (the only
// one that bridges to BridgeData.receiver) first runs `sourceCalls` of any target on Squid's multicall, which holds the
// funds, and bridges whatever is left; LI.FI's live Squid quotes are BridgeCall (a destination call). Symbiosis's
// MetaRouter path forwards `callTo` / `callData` verbatim: the live quote names the final recipient inside that call and
// a revert address that is neither the sender nor the recipient. Both are refused by name, and cross-chain requests
// ask LI.FI to route around them, so their pairs get another bridge.
// fixtures-live-2026-11-02-refunds.json: public li.quest/v1/quote answers of 2026-11-02 with the bridge forced.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionData, parseAbi, type Abi, type Hex} from "viem";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {diamondCallMismatch, type DiamondExpectation} from "../src/calldata.js";
import {lifiProvider} from "../src/provider.js";
import {PARAMS, response} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

type Body = {tool: string; action: {fromAddress: string; toAddress: string; fromAmount: string; toChainId: number; fromToken: {address: string}; toToken: {address: string}}; transactionRequest: {data: Hex}};
const forced = (JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-02-refunds.json", import.meta.url), "utf8")) as {corridors: {tool: string; response: Body}[]}).corridors;
const expectationOf = (b: Body): DiamondExpectation => ({
  fromToken: b.action.fromToken.address, toToken: b.action.toToken.address, amountIn: BigInt(b.action.fromAmount), receiver: b.action.toAddress,
  sender: b.action.fromAddress, minOut: 1n, destChainId: BigInt(b.action.toChainId), sameChain: false, evmDestination: true,
});

const RECEIVER = "0x3333333333333333333333333333333333333333";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ZERO = "0x0000000000000000000000000000000000000000";
const B = "(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall) _bridgeData";
const ABI: Abi = parseAbi([
  `function startBridgeTokensViaSquid(${B}, (uint8 routeType, string destinationChain, string destinationAddress, string bridgedTokenSymbol, address depositAssetId, (uint8 callType, address target, uint256 value, bytes callData, bytes payload)[] sourceCalls, bytes payload, uint256 fee, bool enableExpress) _squidData)`,
] as readonly string[]);

describe("audit 2026-11-02 r5: Squid and Symbiosis are refused and routed around", () => {
  it("the live Squid (BridgeCall) and Symbiosis (MetaRouter) quotes are refused by name", () => {
    for (const tool of ["squid", "symbiosis"]) {
      const c = forced.find((k) => k.tool === tool)!;
      expect(c.response.tool).toBe(tool);
      expect([tool, diamondCallMismatch(c.response.transactionRequest.data, expectationOf(c.response))])
        .toEqual([tool, `${tool === "squid" ? "Squid" : "Symbiosis"} delivers to a recipient the transaction does not bind (an off-chain order or unchecked facet data)`]);
    }
  });

  it("a Squid CallBridge route, whose source calls could move the funds anywhere first, is refused too", () => {
    const callBridge = encodeFunctionData({abi: ABI, functionName: "startBridgeTokensViaSquid", args: [
      {transactionId: `0x${"00".repeat(32)}`, bridge: "squid", integrator: "awk", referrer: ZERO, sendingAssetId: USDC, receiver: RECEIVER, minAmount: 1_000_000n, destinationChainId: 42161n, hasSourceSwaps: false, hasDestinationCall: false},
      {routeType: 1, destinationChain: "arbitrum", destinationAddress: RECEIVER, bridgedTokenSymbol: "USDC", depositAssetId: USDC, sourceCalls: [], payload: "0x", fee: 0n, enableExpress: false},
    ]});
    const e: DiamondExpectation = {fromToken: USDC, toToken: USDC, amountIn: 1_000_000n, receiver: RECEIVER, sender: RECEIVER, minOut: 1n, destChainId: 42161n, sameChain: false, evmDestination: true};
    expect(diamondCallMismatch(callBridge, e)).toMatch(/^Squid delivers to a recipient the transaction does not bind/);
  });

  it("cross-chain requests deny squid and symbiosis (route options and /quote), and an app's allowBridges cannot bring them back", async () => {
    const urls: URL[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (u: URL | string, init?: RequestInit) => {
      urls.push(new URL(String(u)));
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(String(u).includes("/advanced/routes") ? {routes: []} : response()));
    });
    const params: QuoteParams = {...PARAMS};
    expect(await lifiProvider().getQuote(params)).not.toBeNull();
    const quote = urls.find((u) => u.pathname.endsWith("/quote"))!;
    expect(quote.searchParams.getAll("denyBridges")).toEqual(expect.arrayContaining(["squid", "symbiosis"]));

    urls.length = 0;
    const chosen = lifiProvider({chooseRoute: () => ({allowBridges: ["squid", "symbiosis", "across"]})});
    vi.stubGlobal("fetch", async (u: URL | string, init?: RequestInit) => {
      urls.push(new URL(String(u)));
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      const routes = [{toAmount: "990000", toAmountMin: "985050", steps: [{tool: "squid", estimate: {executionDuration: 20}}]}, {toAmount: "980000", toAmountMin: "975000", steps: [{tool: "across", estimate: {executionDuration: 20}}]}];
      return new Response(JSON.stringify(String(u).includes("/advanced/routes") ? {routes} : response()));
    });
    expect(await chosen.getQuote(params)).not.toBeNull();
    const q = urls.find((u) => u.pathname.endsWith("/quote"))!;
    expect(q.searchParams.getAll("allowBridges")).toEqual(["across"]);
    expect(q.searchParams.getAll("denyBridges")).toEqual(expect.arrayContaining(["squid", "symbiosis"]));
    const routesBody = bodies.at(-1) as {options: {bridges: {deny: string[]}}};
    expect(routesBody.options.bridges.deny).toEqual(expect.arrayContaining(["squid", "symbiosis"]));
  });
});
