// Real Across answers (fixtures/api/quotes) through the provider, the pricing rule, the device's checks, the engine
// and the server handler. Every number the tests expect is recomputed here from the raw answers, apart from the module.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {acrossProvider} from "../src/provider.js";
import {acrossRemoteProvider} from "../src/remote.js";
import {AcrossSwap2Protocol} from "../src/protocol.js";
import {decodeAcrossDeposit} from "../src/deposit.js";
import {acrossChain} from "../src/config.js";
import {ACROSS_FILL_WINDOW_S} from "../src/pricing.js";
import {acrossPins} from "../src/verify.js";
import {RECORDED, RPC_URLS, TEST_KEY, feesCall, loadRecorded, quoted, replay, v5Call, type RecordedQuote, type Seen} from "./recorded.js";

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"]}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const PREFUNDED_ADAPTER = "0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94";
const ZERO = "0x0000000000000000000000000000000000000000";

function providerFor(f: RecordedQuote, seen: Seen[] = [], edit?: Parameters<typeof replay>[2]) {
  return acrossProvider({apiKey: TEST_KEY, fetchImpl: replay(f, seen, edit), ...(f.floor ? {suggestedFeesUrl: null, rpcUrls: RPC_URLS} : {})});
}
function withReasons(params: QuoteParams): QuoteParams & {reasons: [string, Swap2RefusalInfo | undefined][]} {
  const reasons: [string, Swap2RefusalInfo | undefined][] = [];
  return {...params, onRefusal: (r, i) => reasons.push([r, i]), reasons};
}

/**
 * The rule, recomputed from the raw answers: F5 = V5 total fee − its origin execution legs (wei on ETH routes, the USD
 * figure at the destination token's price otherwise); the need = /suggested-fees' total (or the recorded floor);
 * fee = max(F5, need).
 */
function expectedFee(f: RecordedQuote): {f5: bigint; need: bigint | null; tolerance: bigint} {
  const v5 = v5Call(f).response;
  const total = BigInt(v5.fee.totalFee.amount);
  const eth = /^0x0{40}$/.test(f.params.destToken);
  let addBack = 0n;
  let tolerance = 0n;
  for (const g of v5.gasEstimates as {leg: string; effect: string; amount: string; amountUsd: string}[]) {
    if (g.leg !== "origin" || g.effect !== "included_in_transfer_fee") continue;
    if (eth) addBack += BigInt(g.amount);
    else {
      addBack += BigInt(Math.floor((Number(g.amountUsd) / v5.destination.token.priceUsd) * 10 ** v5.destination.token.decimals));
      tolerance += 1n;
    }
  }
  const fees = feesCall(f);
  return {f5: total - addBack, need: fees ? BigInt(fees.response.totalRelayFee.total) : null, tolerance};
}

describe("recorded answers → the deposit's numbers (max of V5's net fee and what a relayer needs)", () => {
  for (const name of RECORDED) {
    it(name, async () => {
      const f = loadRecorded(name);
      vi.setSystemTime(f.nowMs);
      const seen: Seen[] = [];
      const ps = withReasons(f.params);
      const q = await providerFor(f, seen).getQuote(ps);

      // What was sent: V5 with the key as a bearer token, /suggested-fees with nothing secret.
      const v5Seen = seen.find((s) => s.url.startsWith("https://api.across.to/"))!;
      expect(v5Seen.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
      expect(v5Seen.method).toBe("POST");
      expect(Object.keys(v5Seen.body as object).sort()).toEqual(["amountType", "authorizationPolicy", "capabilities", "destination", "maxFee", "origin"]);
      for (const s of seen.filter((x) => x !== v5Seen)) expect(JSON.stringify(s)).not.toContain(TEST_KEY);

      if (!quoted(f)) {
        expect(q).toBeNull();
        const {refusal} = f.result as {refusal: {text: string; reason: string | null}};
        expect(ps.reasons).toEqual([[refusal.text, refusal.reason ? {reason: refusal.reason} : undefined]]);
        return;
      }
      expect(ps.reasons).toEqual([]);
      expect(q).not.toBeNull();
      const r = f.result;
      expect(q!.destAmount).toBe(r.outputAmount);
      expect(q!.minDestAmount).toBe(r.outputAmount);
      expect(q!.providerData).toMatchObject({priceSource: r.priceSource, v5Fee: r.v5Fee, relayerFee: r.relayerFee, quoteTimestamp: String(r.quoteTimestamp), fillDeadline: String(r.fillDeadline)});
      expect(q!.etaSeconds).toBe(r.etaSeconds);

      // The rule, apart from the module.
      const amount = BigInt(f.params.amountIn);
      const fee = amount - BigInt(q!.destAmount);
      const want = expectedFee(f);
      const f5 = BigInt(r.v5Fee);
      expect(f5 >= want.f5 - want.tolerance && f5 <= want.f5 + want.tolerance).toBe(true);
      if (want.need !== null) expect(BigInt(r.relayerFee)).toBe(want.need);
      expect(fee).toBe(f5 > BigInt(r.relayerFee) ? f5 : BigInt(r.relayerFee));

      // The deposit: built here, plain — the pinned SpokePool, empty message, no exclusivity, two hours from the quote time.
      const src = acrossChain(f.params.sourceChain)!;
      const args = decodeAcrossDeposit(q!.txRequest!.data!);
      expect(q!.txRequest!.to).toBe(src.spokePool);
      expect(args.message).toBe("0x");
      expect(args.exclusiveRelayer).toBe(ZERO);
      expect(args.exclusivityParameter).toBe(0);
      expect(args.outputAmount).toBe(BigInt(r.outputAmount));
      expect(args.depositor).toBe(String(f.params.sender ?? f.params.refundAddress).toLowerCase());
      expect(args.recipient).toBe(f.params.destAddress.toLowerCase());
      expect(args.fillDeadline).toBe(args.quoteTimestamp + ACROSS_FILL_WINDOW_S);
      const fees = feesCall(f);
      if (fees) expect(args.quoteTimestamp).toBe(Number(fees.response.timestamp));
      else {
        const block = (label: string) => parseInt(f.calls.find((c) => c.kind === "rpc" && c.url === `rpc:${label}`)!.response.result.timestamp, 16);
        expect(args.quoteTimestamp).toBe(Math.min(block("eip155:1") - 60, src.chainId === 1 ? block("eip155:1") : block(src.caip2)));
      }
      // Nothing of V5's own route reaches the quote: not its escrow, not its order id, not its guaranteed minimum.
      const json = JSON.stringify(q);
      expect(json).not.toContain(PREFUNDED_ADAPTER);
      expect(json).not.toContain(v5Call(f).response.orderId);
      expect(json).not.toContain(`"${v5Call(f).response.destination.minAmount}"`);

      // The remote client's own checks pass on it; a dry quote is never built, a live one is built and preflighted.
      expect(acrossPins.verifyQuote!(f.params, q!)).toBeNull();
      const p = providerFor(f);
      if (f.params.dry !== false) {
        expect(r.placeholder).toBe(true);
        await expect(p.buildDeposit(q!)).rejects.toThrow(/\[request-invalid\]/);
      } else {
        const tx = await p.buildDeposit(q!);
        await expect(p.preflightDeposit!(q!, tx)).resolves.toBeUndefined();
        expect(acrossPins.verifyBuild!(q!, tx, f.params)).toBeNull();
      }
    });
  }

  it("the cells the study singled out", () => {
    const bps = (name: string) => { const f = loadRecorded(name); return quoted(f) ? Number(((BigInt(f.params.amountIn) - BigInt(f.result.outputAmount)) * 1_000_000n) / BigInt(f.params.amountIn)) / 100 : NaN; };
    const source = (name: string) => { const f = loadRecorded(name); return quoted(f) && BigInt(f.result.v5Fee) >= BigInt(f.result.relayerFee) ? "v5" : "relayer"; };
    // ETH L2 → L2 at ~$2 000: V5's auction price (~2.7 bps) is under the 5+ bps plain deposits are filled at — the relayer fee binds.
    expect(source("eth-arb-base-2000")).toBe("relayer");
    expect(bps("eth-arb-base-2000")).toBeGreaterThan(5);
    expect(source("eth-arb-base-2000-floor")).toBe("relayer");
    // Ethereum origin: V5's own origin gas is taken out (its fee would be tens of bps more), so a small transfer quotes.
    expect(source("eth-eth-base-5")).toBe("v5");
    expect(bps("eth-eth-base-100")).toBeLessThan(10);
    // Stables: V5's price is the higher one (a few cents a transfer over the relayer market) and stands.
    for (const n of ["usdc-base-arb-25", "usdc-arb-base-2000", "usdc-base-op-5", "usdt-eth-arb-100"]) expect(source(n)).toBe("v5");
  });
});

describe("the engine, on a recorded answer", () => {
  it("USDC Base → Arbitrum: the exact amount approved to the pinned SpokePool, then the deposit built here", async () => {
    const f = loadRecorded("usdc-base-arb-25");
    vi.setSystemTime(f.nowMs);
    const sent: {to?: string; data?: string; value?: bigint}[] = [];
    const account = {
      getAddress: async () => f.params.sender!, getChainId: async () => 8453, getBalance: async () => 10n ** 18n, getAllowance: async () => 0n,
      quoteSendTransaction: async () => ({fee: 1n}), waitForTransaction: async () => {},
      sendTransaction: async (t: {to?: string; data?: string; value?: bigint}) => { sent.push(t); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
    };
    const protocol = new AcrossSwap2Protocol(account as never, {fromChain: "eip155:8453", apiKey: TEST_KEY, fetchImpl: replay(f)});
    await protocol.swap2({fromToken: "USDC", toToken: f.params.destToken, toChain: 42161, recipient: f.params.destAddress, fromTokenAmount: BigInt(f.params.amountIn), minAmountOut: 24_900_000n} as never);
    const base = acrossChain("eip155:8453")!;
    expect(sent).toHaveLength(2);
    // approve(spokePool, 25 USDC)
    expect(sent[0]!.data!.slice(0, 10)).toBe("0x095ea7b3");
    expect(sent[0]!.data!.toLowerCase()).toContain(base.spokePool.slice(2));
    expect(BigInt(`0x${sent[0]!.data!.slice(-64)}`)).toBe(BigInt(f.params.amountIn));
    expect(sent[1]!.to!.toLowerCase()).toBe(base.spokePool);
    expect(decodeAcrossDeposit(sent[1]!.data!).outputAmount).toBe(BigInt((f.result as {outputAmount: string}).outputAmount));
  });
});

describe("remote mode: the real provider behind createSwap2Handler, every answer checked again on the device", () => {
  function backendFor(f: RecordedQuote) {
    const handle = createSwap2Handler<string>({providers: [providerFor(f)], sealSecret: "recorded-test-seal-secret-at-least-32-bytes", guard: () => {}, subject: () => "alice"});
    return (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "user");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
  }

  it.each(["usdc-base-arb-25", "eth-arb-base-2000", "wbtc-eth-arb-100"])("%s: quoted through the backend (intent id with the server's ~tag), built, verified", async (name) => {
    const f = loadRecorded(name);
    vi.setSystemTime(f.nowMs);
    const app = acrossRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backendFor(f)});
    const q = await app.getQuote(f.params);
    expect(q).not.toBeNull();
    expect(q!.intentId).toMatch(/^across:\d+:\d+:[0-9a-f]{32}~[0-9a-f]{32}$/);
    expect(q!.destAmount).toBe((f.result as {outputAmount: string}).outputAmount);
    const tx = await app.buildDeposit(q!);
    expect(tx.to).toBe(acrossChain(f.params.sourceChain)!.spokePool);
    expect(tx.data).toBe(q!.txRequest!.data);
    // A build that is not the quoted deposit is refused on the device.
    const tampered: Quote = {...q!, txRequest: {...q!.txRequest!, data: `${q!.txRequest!.data!}00`}};
    expect(refusalOf(await app.buildDeposit(tampered).catch((e: unknown) => e))).toBeDefined();
  });

  it("a dry quote through the backend: priced for the same placeholder on both sides, verified, never built", async () => {
    const f = loadRecorded("usdc-base-arb-25-dry");
    vi.setSystemTime(f.nowMs);
    const app = acrossRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backendFor(f)});
    const q = await app.getQuote(f.params);
    expect(q).not.toBeNull();
    expect(q!.providerData!.placeholder).toBe("1");
    await expect(app.buildDeposit(q!)).rejects.toThrow();
  });

  it("the backend's refusal reaches the app with its reason", async () => {
    const f = loadRecorded("usdc-base-arb-tiny");
    vi.setSystemTime(f.nowMs);
    const app = acrossRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backendFor(f)});
    const err = await app.getQuote(f.params).catch((e: unknown) => e);
    expect(refusalOf(err)?.reason).toBe("amount_too_small");
  });
});
