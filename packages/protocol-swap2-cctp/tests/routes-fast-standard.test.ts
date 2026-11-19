// Two CCTP routes (2026-11-20): Fast (Circle's fee, seconds to minutes) and Standard (free, waits for the source's
// hard finality). getQuotes shows both so a route list can offer the free, slower one; a picked route is quoted or
// refused, never swapped; the ETA follows Circle's published attestation time per source domain; a remote quote's
// route must be its burn's.
import {describe, expect, it} from "vitest";
import {decodeFunctionData, type Hex} from "viem";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {cctpPins, cctpVerifyQuote} from "../src/provider.js";
import {CCTP_DOMAINS, FINALITY_FAST, FINALITY_STANDARD, STANDARD_ATTESTATION_SECONDS} from "../src/config.js";
import {MESSENGER_ABI, make} from "./fixtures.js";

const ARB = CCTP_DOMAINS["eip155:42161"]!;
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const SENDER = "0x4444444444444444444444444444444444444444";
const PARAMS = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB.usdc, amountIn: "10000000", destAddress: RECIPIENT, refundAddress: SENDER, slippageBps: 0};
const thresholdOf = (data: string | undefined) => decodeFunctionData({abi: MESSENGER_ABI, data: data as Hex}).args![6];

describe("getQuotes: both routes for a route list", () => {
  it("Fast with Circle's fee and Standard at no fee, each with its routeId, threshold and ETA", async () => {
    const {p} = make();
    const quotes = await p.getQuotes!({...PARAMS, dry: true});
    expect(quotes.map((q) => q.routeId)).toEqual(["fast", "standard"]);
    const [fast, standard] = quotes as [NonNullable<(typeof quotes)[0]>, NonNullable<(typeof quotes)[0]>];
    expect(fast.destAmount).toBe("9998570");
    expect(thresholdOf(fast.txRequest!.data)).toBe(FINALITY_FAST);
    expect(fast.etaSeconds).toBe(45);
    expect(standard.destAmount).toBe("10000000");
    expect(standard.fees).toEqual([]);
    expect(standard.intentId).toBe(`cctp:6:3:${FINALITY_STANDARD}`);
    expect(thresholdOf(standard.txRequest!.data)).toBe(FINALITY_STANDARD);
    // Base: its batch finalizes on Ethereum, ~15–19 min, plus the claim.
    expect(standard.etaSeconds).toBe(1140 + 40);
  });

  it("a pair with Standard only (a fast-finality source) lists Standard alone; an exhausted Fast allowance too", async () => {
    expect((await make({fees: [{finalityThreshold: 2000, minimumFee: 0}]}).p.getQuotes!({...PARAMS, dry: true})).map((q) => q.routeId)).toEqual(["standard"]);
    expect((await make({allowance: 5}).p.getQuotes!({...PARAMS, dry: true})).map((q) => q.routeId)).toEqual(["standard"]);
  });

  it("Standard is listed only when it saves something: with no Fast fee (Avalanche) the same amount is not shown twice", async () => {
    const free = make({fees: [{finalityThreshold: 1000, minimumFee: 0}, {finalityThreshold: 2000, minimumFee: 0}]});
    expect((await free.p.getQuotes!({...PARAMS, dry: true})).map((q) => q.routeId)).toEqual(["fast"]);
    // …but a picked Standard is still quoted
    expect((await free.p.getQuote({...PARAMS, routeId: "standard"}))!.routeId).toBe("standard");
  });

  it("mode keeps one route only; candidates are previews: a live request gets none", async () => {
    expect((await make({}, {mode: "fast"}).p.getQuotes!({...PARAMS, dry: true})).map((q) => q.routeId)).toEqual(["fast"]);
    expect((await make({}, {mode: "standard"}).p.getQuotes!({...PARAMS, dry: true})).map((q) => q.routeId)).toEqual(["standard"]);
    expect(await make().p.getQuotes!({...PARAMS, dry: false})).toEqual([]);
  });

  it("the ETA of Standard follows the source domain: seconds on fast-finality chains, ~30 min from Ink, hours from Linea", async () => {
    const eta = async (sourceChain: string) => (await make().p.getQuote({...PARAMS, sourceChain, routeId: "standard"}))!.etaSeconds;
    expect(await eta("eip155:1")).toBe(1180);
    expect(await eta("eip155:43114")).toBe(48);
    expect(await eta("eip155:57073")).toBe(1840);
    expect(await eta("eip155:59144")).toBe(115_240);
    // every domain has a row
    for (const d of Object.values(CCTP_DOMAINS)) expect(STANDARD_ATTESTATION_SECONDS[d.domain], d.name).toBeGreaterThan(0);
  });
});

describe("a picked route is quoted or refused, never swapped", () => {
  it("routeId 'standard' quotes Standard even where Fast is offered; without one, auto still takes Fast", async () => {
    const {p} = make();
    expect((await p.getQuote({...PARAMS, routeId: "standard"}))!.routeId).toBe("standard");
    expect((await p.getQuote(PARAMS))!.routeId).toBe("fast");
  });

  it("routeId 'fast' with the Fast allowance exhausted is refused, not turned into a 20-minute Standard transfer", async () => {
    const reasons: string[] = [];
    expect(await make({allowance: 5}).p.getQuote({...PARAMS, routeId: "fast", onRefusal: (r) => reasons.push(r)})).toBeNull();
    expect(reasons[0]).toMatch(/allowance is exhausted/);
  });

  it("an unknown route, or one the provider's mode turned off, is refused (policy_refused)", async () => {
    const out: {text: string; reason: string | undefined}[] = [];
    const onRefusal = (text: string, info?: {reason?: string}) => { out.push({text, reason: info?.reason}); };
    expect(await make().p.getQuote({...PARAMS, routeId: "slow", onRefusal})).toBeNull();
    expect(await make({}, {mode: "fast"}).p.getQuote({...PARAMS, routeId: "standard", onRefusal})).toBeNull();
    expect(out).toEqual([{text: "unknown route 'slow' (fast | standard)", reason: "policy_refused"}, {text: "the standard route is turned off (mode: fast)", reason: "policy_refused"}]);
  });
});

describe("cctpVerifyQuote: the route is the burn's", () => {
  it("a Standard burn labelled 'fast' (or answering a 'fast' request) is refused; matching labels pass", async () => {
    const {p} = make();
    const standard = (await p.getQuote({...PARAMS, routeId: "standard"}))!;
    expect(cctpVerifyQuote({...PARAMS, routeId: "standard"}, standard)).toBeNull();
    expect(cctpVerifyQuote(PARAMS, {...standard, routeId: "fast"})).toMatch(/the burn is a standard transfer, not the 'fast' route/);
    expect(cctpPins.reasonOf!(cctpVerifyQuote(PARAMS, {...standard, routeId: "fast"})!)).toEqual({reason: "policy_refused"});
    expect(cctpVerifyQuote({...PARAMS, routeId: "fast"}, standard)).toMatch(/not the 'fast' route/);
    // a quote from an older server without a routeId is still checked on the burn alone
    const {routeId: _r, ...unlabelled} = standard;
    expect(cctpVerifyQuote(PARAMS, unlabelled)).toBeNull();
  });
});

describe("remote: both routes over the sealed API (multiQuotes)", () => {
  it("lists Fast and Standard, and the picked Standard route builds a Standard burn", async () => {
    const {p} = make();
    const handle = createSwap2Handler({providers: [p], sealSecret: "cctp-test-secret-with-at-least-32-bytes-long", guard: () => {}, subject: (id: string) => id});
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await handle(String(url).split("/").pop()!, JSON.parse(String(init!.body)), "alice");
      return Response.json(response.body, {status: response.status});
    };
    const client = remoteProvider({name: "cctp", baseUrl: "https://backend.test", multiQuotes: true, fetchImpl, ...cctpPins});
    const candidates = await client.getQuotes!({...PARAMS, dry: true});
    expect(candidates.map((q) => q.routeId)).toEqual(["fast", "standard"]);
    const q = (await client.getQuote({...PARAMS, routeId: "standard", dry: false}))!;
    expect(q.routeId).toBe("standard");
    expect(q.destAmount).toBe("10000000");
    const tx = await client.buildDeposit(q);
    expect(thresholdOf(tx.data)).toBe(FINALITY_STANDARD);
  });
});
