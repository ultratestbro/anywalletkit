// LI.FI Intents between EVM chains (review r2 of the EVM → Solana change, 2026-11-13). LiFiIntentEscrowFacetV2 escrows the
// input for an order whose input oracle, output oracle, output settler and output amount multiplier all come from the
// calldata: the escrow releases the input on the word of that oracle, and the committed output is `input × multiplier /
// 1e18`. None of them was checked, so an API or an `apiUrl` proxy could name its own oracle (attesting a fill that never
// happened) or a near-zero multiplier while the recipient and refund address stayed right. Refused to Solana since round 1;
// now between EVM chains too: the Diamond call is refused with a named reason on every route, and every cross-chain
// request from an EVM chain asks LI.FI to deny `lifiIntents`.
// fixtures-live-2026-11-13-evm-intents.json: read-only answers of the public li.quest/v1/quote (no API key, nothing signed):
// 14 EVM → EVM corridors quoted by the built provider with LI.FI Intents denied (13 quote through Across, Polymer CCTP,
// LayerSwap or NEAR Intents; Base USDC → Elysium USDC.e, which LI.FI serves only through LI.FI Intents, has no route), and
// three LI.FI Intents answers asked for explicitly. Before this change the same 14 corridors all quoted, two of them
// (BSC USDT → Arbitrum USDC, Base USDC → Elysium USDC.e) through LI.FI Intents.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, parseAbi, type Abi, type Hex} from "viem";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {diamondCallMismatch, type DiamondExpectation} from "../src/calldata.js";
import {lifiPins, lifiProvider, lifiVerifyQuote} from "../src/provider.js";
import {PARAMS, response} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

type Answer = {tool?: string; action: {fromToken: {address: string}; fromAmount: string; slippage?: number}; estimate: {toAmountMin: string}; transactionRequest: {to: string; data: string; value: string; chainId: number}};
type Corridor = {name: string; beforeTool?: string; params: QuoteParams; status?: number; response: Answer};
const live = JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-13-evm-intents.json", import.meta.url), "utf8")) as {corridors: Corridor[]; intents: Corridor[]};
const oct30 = JSON.parse(readFileSync(new URL("./fixtures-live-2026-10-30.json", import.meta.url), "utf8")) as {corridors: {name: string; params: QuoteParams; responses: {body: Answer}[]}[]};
const nov02 = JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-02.json", import.meta.url), "utf8")) as {corridors: Corridor[]};

const INTENTS_UNPINNED = "a LI.FI Intents order to an EVM chain names its own oracles, output settler and output amount, which cannot be checked here — its escrow could release the input without the delivery";
const INTENTS_TO_SOLANA = "a LI.FI Intents order to Solana names its own oracles, output settler and output amount, which cannot be checked here — its escrow could release the input without the delivery";
const NON_EVM_UNREAD = "the recipient on a non-EVM destination sits in bridge-specific data and cannot be checked here";
const DENIED = ["relaydepository", "garden", "squid", "symbiosis", "lifiIntents"];

/** LI.FI answers with `answer`, echoing the slippage asked. */
function replay(answer: unknown, urls: URL[] = [], bodies: {options?: Record<string, unknown>}[] = [], routes: unknown = {routes: []}) {
  vi.stubGlobal("fetch", async (u: URL | string, init?: RequestInit) => {
    const url = new URL(String(u));
    urls.push(url);
    if (url.pathname.endsWith("/advanced/routes")) { bodies.push(JSON.parse(String(init!.body))); return new Response(JSON.stringify(routes)); }
    const a = answer as {action: object};
    return new Response(JSON.stringify({...a, action: {...a.action, slippage: Number(url.searchParams.get("slippage"))}}));
  });
}
async function quote(answer: unknown, params: QuoteParams) {
  replay(answer);
  const reasons: string[] = [];
  const q = await lifiProvider().getQuote({...params, onRefusal: (r) => reasons.push(r)});
  return {q, reasons};
}
/** The quote the provider used to hand out for an answer: the shape lifiVerifyQuote checks on the device. */
function asQuote(params: QuoteParams, a: Answer): Quote {
  const tr = a.transactionRequest;
  const native = /^0x0{40}$/.test(a.action.fromToken.address);
  const value = BigInt(tr.value);
  const fee = native ? value - BigInt(params.amountIn) : value;
  return {
    provider: "lifi", intentId: `lifi:${tr.chainId}:${params.destChain.split(":")[1]}`, depositAddress: "", depositMemo: null, sourceAmount: params.amountIn,
    destAmount: a.estimate.toAmountMin, minDestAmount: a.estimate.toAmountMin, feeUsd: 0, etaSeconds: 60, reliability: 1, validUntilMs: Date.now() + 60_000,
    txRequest: {to: tr.to, data: tr.data, value: value.toString(), chainId: tr.chainId, ...(native ? {} : {approvalAddress: tr.to}), ...(fee > 0n ? {nativeFee: fee.toString()} : {})},
  };
}

const B = "(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)";
const S = "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[]";
const T = `(bytes32 dstCallReceiver, bytes32 recipient, address depositAndRefundAddress, uint256 nonce, uint32 expires, uint32 fillDeadline, address inputOracle, bytes32 outputOracle, bytes32 outputSettler, bytes32 outputToken, uint128 outputAmountMultiplier, ${S} dstCallSwapData, bytes outputContext)`;
const ABI: Abi = parseAbi([
  `function startBridgeTokensViaLiFiIntentEscrowV2(${B} _bridgeData, ${T} _facetData)`,
  `function swapAndStartBridgeTokensViaLiFiIntentEscrowV2(${B} _bridgeData, ${S} _swapData, ${T} _facetData)`,
] as readonly string[]);

describe("LI.FI Intents between EVM chains: the Diamond call is refused on every route", () => {
  it("the recorded LI.FI Intents answers (2026-11-13, 2026-11-02, 2026-10-30) are refused by the provider and by the remote pin", async () => {
    const answers: [string, QuoteParams, Answer][] = [
      ...live.intents.map((c) => [`11-13 ${c.name}`, c.params, c.response] as [string, QuoteParams, Answer]),
      ...nov02.corridors.filter((c) => c.response?.tool === "lifiIntents" && c.params.sourceChain.startsWith("eip155:")).map((c) => [`11-02 ${c.name}`, c.params, c.response] as [string, QuoteParams, Answer]),
      ...oct30.corridors.filter((c) => c.responses.at(-1)?.body?.tool === "lifiIntents").map((c) => [`10-30 ${c.name}`, c.params, c.responses.at(-1)!.body] as [string, QuoteParams, Answer]),
    ];
    expect(answers.map(([n]) => n)).toEqual(["11-13 bsc-usdt>arb-usdc", "11-13 op-eth>base-eth", "11-13 base-usdc>elysium-usdce", "11-02 evm-op-eth-base-eth", "10-30 bsc-usdt>arb-usdc default"]);
    for (const [name, params, answer] of answers) {
      // Both entry points occur live: swapAndStart… (0x6d21c5df) on 11-13, and the call decodes as an Intents order.
      expect(["0x7dbcf1d9", "0x6d21c5df"]).toContain(answer.transactionRequest.data.slice(0, 10));
      expect(decodeFunctionData({abi: ABI, data: answer.transactionRequest.data as Hex}).functionName).toMatch(/LiFiIntentEscrowV2$/);
      const {q, reasons} = await quote(answer, params);
      expect([name, q, reasons]).toEqual([name, null, [`lifi: the transaction does not match the quote: ${INTENTS_UNPINNED}`]]);
      expect([name, lifiVerifyQuote(params, asQuote(params, answer))]).toEqual([name, `the transaction does not match the request: ${INTENTS_UNPINNED}`]);
      expect(lifiPins.verifyQuote).toBe(lifiVerifyQuote);
    }
  });

  it("diamondCallMismatch: both entry points, an honest order (recipient, refund to the sender) or not, to an EVM chain, on a same-chain route; Solana keeps its text", () => {
    const RECEIVER = "0x3333333333333333333333333333333333333333";
    const SENDER = "0x4444444444444444444444444444444444444444";
    const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
    const order = {dstCallReceiver: `0x${"00".repeat(32)}` as Hex, recipient: pad(RECEIVER), depositAndRefundAddress: SENDER as Hex, nonce: 1n, expires: 1, fillDeadline: 1,
      inputOracle: SENDER as Hex, outputOracle: pad(SENDER), outputSettler: pad(SENDER), outputToken: pad(USDC), outputAmountMultiplier: 10n ** 18n, dstCallSwapData: [], outputContext: "0x" as Hex};
    const bridge = (dest: bigint, swaps: boolean, receiver = RECEIVER) => ({transactionId: `0x${"00".repeat(32)}` as Hex, bridge: "lifiIntents", integrator: "awk", referrer: `0x${"00".repeat(20)}` as Hex,
      sendingAssetId: USDC as Hex, receiver: receiver as Hex, minAmount: 1_000_000n, destinationChainId: dest, hasSourceSwaps: swaps, hasDestinationCall: false});
    const step = [{callTo: SENDER as Hex, approveTo: SENDER as Hex, sendingAssetId: USDC as Hex, receivingAssetId: USDC as Hex, fromAmount: 1_000_000n, callData: "0x" as Hex, requiresDeposit: true}];
    const call = (dest: bigint, swaps: boolean, receiver?: string) => encodeFunctionData({abi: ABI, functionName: swaps ? "swapAndStartBridgeTokensViaLiFiIntentEscrowV2" : "startBridgeTokensViaLiFiIntentEscrowV2",
      args: (swaps ? [bridge(dest, true, receiver), step, order] : [bridge(dest, false, receiver), order]) as never});
    const e: DiamondExpectation = {fromToken: USDC, toToken: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", amountIn: 1_000_000n, receiver: RECEIVER, sender: SENDER, minOut: 1n, destChainId: 42161n, sameChain: false, evmDestination: true};
    for (const swaps of [false, true]) {
      expect([swaps, diamondCallMismatch(call(42161n, swaps), e)]).toEqual([swaps, INTENTS_UNPINNED]);
      // Whatever else the call says — another destination chain, another receiver — the Intents refusal comes first.
      expect([swaps, diamondCallMismatch(call(10n, swaps, SENDER), e)]).toEqual([swaps, INTENTS_UNPINNED]);
      expect([swaps, diamondCallMismatch(call(8453n, swaps), {...e, destChainId: 8453n, sameChain: true})]).toEqual([swaps, INTENTS_UNPINNED]);
      // To Solana the round-1 refusal is unchanged (BridgeData names LI.FI's Solana id and its non-EVM placeholder).
      const toSolana = {...e, toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", receiver: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk", destChainId: 1151111081099710n, evmDestination: false};
      expect([swaps, diamondCallMismatch(call(1151111081099710n, swaps, "0x11f111f111f111f111f111f111f111f111f111f1"), toSolana)]).toEqual([swaps, INTENTS_TO_SOLANA]);
      // Another non-EVM destination keeps the non-EVM refusal.
      expect([swaps, diamondCallMismatch(call(20000000000001n, swaps), {...toSolana, destChainId: 20000000000001n})]).toEqual([swaps, NON_EVM_UNREAD]);
    }
  });

  it("other bridges between EVM chains are unaffected: the corridors LI.FI serves with LI.FI Intents denied (live, 2026-11-13) pass the provider and the remote pin", async () => {
    const quoted = live.corridors.filter((c) => c.status === 200);
    expect(live.corridors.length).toBe(14);
    expect(quoted.length).toBe(13);
    // Before: all 14 quoted, two through LI.FI Intents. After: LI.FI serves those through other bridges, or not at all.
    expect(live.corridors.filter((c) => c.beforeTool === "lifiIntents").map((c) => c.name)).toEqual(["bsc-usdt>arb-usdc", "base-usdc>elysium-usdce"]);
    expect([...new Set(quoted.map((c) => c.response.tool))].sort()).toEqual(["across", "layerswap", "near", "polymerStandard"]);
    for (const c of quoted) {
      const {q, reasons} = await quote(c.response, c.params);
      expect([c.name, reasons]).toEqual([c.name, []]);
      expect([c.name, typeof q?.txRequest?.data, lifiVerifyQuote(c.params, q!)]).toEqual([c.name, "string", null]);
    }
    // Base USDC → Elysium USDC.e: LI.FI Intents was its only bridge; with it denied LI.FI has no route, and says so.
    const elysium = live.corridors.find((c) => c.name === "base-usdc>elysium-usdce")!;
    expect(elysium.status).toBe(404);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(elysium.response), {status: 404}));
    const reasons: string[] = [];
    expect(await lifiProvider().getQuote({...elysium.params, onRefusal: (r) => reasons.push(r)})).toBeNull();
    expect(reasons).toEqual(["lifi: No available quotes for the requested transfer"]);
  });
});

describe("LI.FI Intents between EVM chains: requests route around it", () => {
  const route = (tool: string) => ({toAmount: "990000", toAmountMin: "985050", steps: [{tool, estimate: {executionDuration: 30}, includedSteps: [{type: "cross", tool}]}]});

  it("/quote and /advanced/routes deny lifiIntents next to the unbound bridges on EVM → EVM; not on a same-chain swap or from Solana", async () => {
    const urls: URL[] = [], bodies: {options?: Record<string, unknown>}[] = [];
    replay(response(), urls, bodies, {routes: [route("across")]});
    expect(await lifiProvider().getQuote(PARAMS)).not.toBeNull();
    expect(urls[0]!.searchParams.getAll("denyBridges")).toEqual(DENIED);
    expect(await lifiProvider({chooseRoute: () => null}).getQuote(PARAMS)).not.toBeNull();
    expect(bodies[0]!.options).toMatchObject({bridges: {deny: DENIED}});
    expect(urls.at(-1)!.searchParams.getAll("denyBridges")).toEqual(DENIED);
    urls.length = 0;
    await lifiProvider().getQuote({...PARAMS, destChain: PARAMS.sourceChain});
    expect(urls[0]!.searchParams.getAll("denyBridges")).toEqual([]);
    await lifiProvider().getQuote({sourceChain: "solana:mainnet", sourceToken: "SOL", destChain: "eip155:8453", destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amountIn: "100000000", destAddress: PARAMS.destAddress, refundAddress: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk", dry: false});
    expect(urls[1]!.searchParams.getAll("denyBridges")).toEqual([]);
  });

  it("a route policy never sees a LI.FI Intents candidate, and cannot pick it: alone it leaves LI.FI's default pick (Intents denied), next to another bridge only that one", async () => {
    let seen: string[] = [];
    const urls: URL[] = [], bodies: {options?: Record<string, unknown>}[] = [];
    replay(response(), urls, bodies, {routes: [route("lifiIntents"), route("across"), route("relaydepository"), route("stargateV2")]});
    expect(await lifiProvider({chooseRoute: (r) => { seen = r.map((o) => o.tool); return {allowBridges: ["across"]}; }}).getQuote(PARAMS)).not.toBeNull();
    expect(seen).toEqual(["across", "stargateV2"]);
    expect(urls.at(-1)!.searchParams.getAll("allowBridges")).toEqual(["across"]);
    await lifiProvider({chooseRoute: () => ({allowBridges: ["lifiIntents"]})}).getQuote(PARAMS);
    expect(urls.at(-1)!.searchParams.getAll("allowBridges")).toEqual([]);
    expect(urls.at(-1)!.searchParams.getAll("denyBridges")).toEqual(DENIED);
    await lifiProvider({chooseRoute: () => ({allowBridges: ["lifiIntents", "stargateV2"]})}).getQuote(PARAMS);
    expect(urls.at(-1)!.searchParams.getAll("allowBridges")).toEqual(["stargateV2"]);
    // A policy that only offers a LI.FI Intents candidate hands the app no candidate: LI.FI's default pick, Intents denied.
    seen = ["unset"];
    replay(response(), urls, bodies, {routes: [route("lifiIntents")]});
    await lifiProvider({chooseRoute: (r) => { seen = r.map((o) => o.tool); return {allowBridges: ["lifiIntents"]}; }}).getQuote(PARAMS);
    expect(seen).toEqual(["unset"]);
    expect(urls.at(-1)!.searchParams.getAll("allowBridges")).toEqual([]);
  });
});
