// LI.FI bridges whose Diamond entry point does not tie the delivery to BridgeData.receiver. RelayDepositoryFacet deposits
// against an `orderId` (Relay's off-chain order names the recipient), so a checked receiver proves nothing: swapping in
// another orderId kept every check green. Relay — and Garden, deBridge DLN and ThorSwap, which carry the destination in
// facet data or an off-chain order the facet never compares — are now refused by name, and the provider asks LI.FI to
// route around Relay and Garden (and, since round 5, Squid and Symbiosis — audit-2026-11-02-r5-squid-symbiosis.test.ts).
// fixtures-live-2026-11-02.json: public li.quest/v1/quote answers of 2026-11-02, requested with those bridges denied.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, parseAbi, type Abi, type Hex} from "viem";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {diamondCallMismatch, type DiamondExpectation} from "../src/calldata.js";
import {lifiProvider, lifiVerifyQuote} from "../src/provider.js";
import {DIAMOND_ABI, PARAMS, response} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

type Body = {transactionRequest?: {data?: string}; tool?: string};
type Corridor = {name: string; params: Record<string, unknown>; responses: {status: number; body: Body}[]};
const oct30 = JSON.parse(readFileSync(new URL("./fixtures-live-2026-10-30.json", import.meta.url), "utf8")) as {corridors: Corridor[]};
const nov02 = JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-02.json", import.meta.url), "utf8")) as {corridors: {name: string; params: QuoteParams; response: Body}[]};

const RECEIVER = "0x3333333333333333333333333333333333333333";
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const B = "(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall) _bridgeData";
const SQUID = "(uint8 routeType, string destinationChain, string destinationAddress, string bridgedTokenSymbol, address depositAssetId, (uint8 callType, address target, uint256 value, bytes callData, bytes payload)[] sourceCalls, bytes payload, uint256 fee, bool enableExpress) _squidData";
const ABI: Abi = parseAbi([
  `function startBridgeTokensViaGarden(${B}, (address redeemer, address refundAddress, uint256 timelock, bytes32 secretHash, bytes32 nonEvmReceiver) _gardenData)`,
  `function startBridgeTokensViaSquid(${B}, ${SQUID})`,
] as readonly string[]);
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const bridgeData = {transactionId: ZERO32, bridge: "x", integrator: "awk", referrer: "0x0000000000000000000000000000000000000000" as Hex, sendingAssetId: USDC as Hex, receiver: RECEIVER as Hex, minAmount: 1_000_000n, destinationChainId: 42161n, hasSourceSwaps: false, hasDestinationCall: false};
const expectation: DiamondExpectation = {fromToken: USDC, toToken: USDC, amountIn: 1_000_000n, receiver: RECEIVER, sender: RECEIVER, minOut: 1n, destChainId: 42161n, sameChain: false, evmDestination: true};

describe("audit 2026-11-02: bridges whose recipient the Diamond does not bind", () => {
  it("a live Relay quote with its orderId swapped is refused by the provider and by the remote pin, and so is the original", async () => {
    const c = oct30.corridors.find((k) => k.responses.some((r) => r.body?.tool === "relaydepository"))!;
    const resp = c.responses.find((r) => r.body?.tool === "relaydepository")!.body;
    const data = resp.transactionRequest!.data as Hex;
    const call = decodeFunctionData({abi: DIAMOND_ABI, data});
    expect(call.functionName).toMatch(/StartBridgeTokensViaRelayDepository$/i);
    const args = [...call.args!] as unknown[];
    const relay = args[args.length - 1] as {orderId: Hex; depositorAddress: Hex};
    args[args.length - 1] = {...relay, orderId: `0x${"66".repeat(32)}` as Hex};
    const forgedData = encodeFunctionData({abi: DIAMOND_ABI, functionName: call.functionName, args: args as never});
    for (const tx of [forgedData, data]) {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({...resp, transactionRequest: {...resp.transactionRequest, data: tx}})));
      const reasons: string[] = [];
      const params = {...c.params, onRefusal: (r: string) => reasons.push(r)} as never;
      expect(await lifiProvider().getQuote(params)).toBeNull();
      expect(reasons[0]).toMatch(/Relay delivers to a recipient the transaction does not bind/);
      // The remote pin decodes the same calldata on the device.
      const quote = {provider: "lifi", intentId: "lifi:8453:42161", depositAddress: "", depositMemo: null, sourceAmount: (c.params as {amountIn: string}).amountIn,
        destAmount: "1", minDestAmount: "1", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 1000,
        txRequest: {to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: tx, value: "0", chainId: 8453, approvalAddress: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"}};
      expect(lifiVerifyQuote(c.params as never, quote as never)).toMatch(/Relay delivers/);
    }
  });

  it("Garden (HTLC redeemer + off-chain order), deBridge DLN and ThorSwap are refused; so is Squid, on every route", () => {
    const garden = encodeFunctionData({abi: ABI, functionName: "startBridgeTokensViaGarden", args: [bridgeData, {redeemer: RECEIVER, refundAddress: RECEIVER, timelock: 1n, secretHash: `0x${"11".repeat(32)}`, nonEvmReceiver: ZERO32}]});
    expect(diamondCallMismatch(garden, expectation)).toMatch(/^Garden delivers/);
    // Selectors only: the calldata never decodes past them.
    expect(diamondCallMismatch(`0x4004633e${"00".repeat(64)}`, expectation)).toMatch(/^deBridge DLN delivers/);
    expect(diamondCallMismatch(`0x2c7d2db0${"00".repeat(96)}`, expectation)).toMatch(/^deBridge DLN delivers/);
    expect(diamondCallMismatch(`0x2541ec57${"00".repeat(64)}`, expectation)).toMatch(/^ThorSwap delivers/);
    const squid = (routeType: number) => encodeFunctionData({abi: ABI, functionName: "startBridgeTokensViaSquid", args: [bridgeData, {
      routeType, destinationChain: "arbitrum", destinationAddress: "0x9999999999999999999999999999999999999999", bridgedTokenSymbol: "USDC", depositAssetId: USDC, sourceCalls: [], payload: "0x", fee: 0n, enableExpress: false,
    }]});
    // BridgeCall, CallBridge and CallBridgeCall: CallBridge's source calls run on Squid's multicall with the funds.
    for (const route of [0, 1, 2]) expect(diamondCallMismatch(squid(route), expectation)).toMatch(/^Squid delivers to a recipient the transaction does not bind/);
  });

  it("asks LI.FI to route around Relay, Garden, Squid and Symbiosis on every cross-chain request, not on a same-chain swap", async () => {
    const urls: URL[] = [];
    vi.stubGlobal("fetch", async (u: URL | string) => { urls.push(new URL(String(u))); return new Response(JSON.stringify(response())); });
    expect(await lifiProvider().getQuote(PARAMS)).not.toBeNull();
    expect(urls[0]!.searchParams.getAll("denyBridges")).toEqual(["relaydepository", "garden", "squid", "symbiosis"]);
    await lifiProvider().getQuote({...PARAMS, destChain: PARAMS.sourceChain});
    expect(urls[1]!.searchParams.getAll("denyBridges")).toEqual([]);
  });

  it("the corridors LI.FI serves with Relay and Garden denied (live, 2026-11-02) pass the provider and the remote pin", async () => {
    const evm = nov02.corridors.filter((c) => c.name.startsWith("evm-"));
    expect(evm.length).toBeGreaterThanOrEqual(9);
    const tools = new Set<string>();
    for (const c of evm) {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify(c.response)));
      const reasons: string[] = [];
      const quote = await lifiProvider().getQuote({...c.params, onRefusal: (r) => reasons.push(r)});
      expect([c.name, reasons]).toEqual([c.name, []]);
      expect([c.name, lifiVerifyQuote(c.params, quote!)]).toEqual([c.name, null]);
      tools.add(c.response.tool!);
    }
    // gnosis xDAI → Arbitrum USDC was Relay's on 2026-10-30; LI.FI now routes it through NEAR Intents.
    expect([...tools].sort()).toEqual(["across", "arbitrum", "lifiIntents", "near", "polymerStandard"]);
  });
});
