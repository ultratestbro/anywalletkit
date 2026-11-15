/**
 * Review 2026-11-15 (round 3). Same threat model as round 2: the 0x API, the backend and the app's RPC are one hostile
 * party. What it cannot do any more:
 *
 *  1. HIGH — send a native-coin sale's value to a Settler that was not live when the chain table was pinned. The value
 *     goes straight to the target address, so a deployment inside the margin (which a lying RPC can claim holds code)
 *     would strand it or hand it to whatever 0x deploys there later. Native sales go only to `newestLiveNonce` or
 *     `previousLiveNonce`; token sales keep the margin (a Permit2 signature is spent only with the account as
 *     msg.sender). Reviewer's reproduction: scratch-tests/rev-r3-security.test.ts, part A (the engine sent the input to
 *     Base 23 and 24).
 *  2. MEDIUM — call a Settler the registry dropped while the user was on the review sheet, in remote mode:
 *     zeroExRemoteProvider re-reads the registry on the device right before broadcast (part C), and a native-sale quote
 *     may stay valid for at most ZEROEX_MAX_NATIVE_QUOTE_SECONDS.
 *  3. LOW — name a replaced Settler: the oldest accepted is the previous one live at pin time (part B: Base 5 and 12,
 *     whose code predates what the checks rely on). The table is validated.
 *  4. verify:live tells a stale pin apart (scripts/pin-status.mjs).
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {ZEROEX_CHAINS, ZEROEX_SETTLER_MAX_NONCE, ZEROEX_SETTLER_NONCE_MARGIN, ZEROEX_SETTLER_REGISTRY, zeroExChains, type ZeroExChain} from "../src/chains.js";
import {ZeroExSwap2Protocol} from "../src/protocol.js";
import {zeroExProvider} from "../src/provider.js";
import {zeroExRefusalReason, zeroExRemoteProvider, zeroExVerifyQuote} from "../src/remote.js";
import {ZEROEX_MAX_NATIVE_QUOTE_SECONDS, checkZeroExTransaction, createSettlerResolver, zeroExSettlerAddress, type SettlerResolver} from "../src/settler.js";
import {pinStatus} from "../scripts/pin-status.mjs";
import {AMOUNT, ME, PREV_SETTLER, RPC, SETTLER, USDC, ZERO, executeData, getKey, nativeCheckAction, stub} from "./fixtures.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const caught = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);
const BASE = ZEROEX_CHAINS[8453]!;
const ETH_IN = 10n ** 15n;
const NATIVE_MIN = 2_487_500n; // 50 bps under the stubbed 2_500_000
const TOKEN_MIN = 398_000_000_000_000n;
const OLD = (nonce: number) => zeroExSettlerAddress(8453, nonce);

interface Sent {to?: string; value?: bigint; data?: string}
function account(sent: Sent[], signed: {message: {spender: string}}[] = []) {
  return {
    getAddress: async () => ME, getChainId: async () => 8453, getBalance: async () => 10n ** 18n, getAllowance: async () => 0n,
    quoteSendTransaction: async () => ({fee: 1n}), waitForTransaction: async () => {},
    signTypedData: async (t: {message: {spender: string}}) => { signed.push(t); return `0x${"5a".repeat(65)}`; },
    sendTransaction: async (t: Sent) => { sent.push(t); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
  };
}
const nativeSale = {fromToken: "ETH", toToken: USDC, toChain: 8453, recipient: ME, fromTokenAmount: ETH_IN, minAmountOut: NATIVE_MIN};
const tokenSale = {fromToken: "USDC", toToken: ZERO, toChain: 8453, recipient: ME, fromTokenAmount: AMOUNT, minAmountOut: TOKEN_MIN};
const nativeParams = (over: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:8453", destChain: "eip155:8453", sourceToken: ZERO, destToken: USDC, amountIn: ETH_IN.toString(), slippageBps: 50, destAddress: ME, refundAddress: ME, dry: false, ...over});
const tokenParams = (over: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:8453", destChain: "eip155:8453", sourceToken: USDC, sourceDecimals: 6, destToken: ZERO, amountIn: AMOUNT.toString(), slippageBps: 50, destAddress: ME, refundAddress: ME, dry: false, ...over});
const nativeText = (nonce: number, to: string) =>
  `zeroex: the swap sends native coin to Settler deployment ${nonce} (${to}) on chain 8453, newer than the newest one live when this module's chain table was pinned (${BASE.newestLiveNonce}) — a native-coin sale goes only to a pinned Settler: update @anywalletkit/protocol-swap2-0x`;

/** A native sale's Settler call as 0x builds it, to `to` (checkZeroExTransaction directly). */
function nativeTx(to: string) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  return {to, data: executeData({recipient: ME, buyToken: USDC, min: NATIVE_MIN, first: nativeCheckAction(deadline, ETH_IN)}), value: ETH_IN.toString(), chainId: 8453};
}
const nativeExpectation = (settlers: readonly string[], chain?: ZeroExChain) => ({chainId: 8453, ...(chain ? {chain} : {}), settlers, sellToken: ZERO, buyToken: USDC, sellAmount: ETH_IN, recipient: ME, minBuyAmount: NATIVE_MIN});

// ── 1. native value goes only to a Settler live at pin time ─────────────────

describe("1. a native-coin sale goes only to the current or previous Settler live when the table was pinned", () => {
  it("the table pins both, per chain (2026-11-15, verify:live); token sales keep a margin of two past the newest", () => {
    expect(Object.fromEntries(Object.entries(ZEROEX_CHAINS).map(([id, c]) => [id, [c.newestLiveNonce, c.previousLiveNonce]]))).toEqual({
      1: [21, 20], 10: [21, 20], 56: [23, 22], 137: [20, 19], 8453: [22, 21], 42161: [20, 19], 43114: [20, 19],
    });
    expect(ZEROEX_SETTLER_NONCE_MARGIN).toBe(2);
    for (const c of Object.values(ZEROEX_CHAINS)) expect(c).not.toHaveProperty("maxSettlerNonce");
  });

  for (const nonce of [23, 24]) {
    describe(`the reviewer's attack: Base ${nonce} (inside the margin, not deployed) named by the RPC and the API, the RPC claiming code there`, () => {
      const EMPTY = OLD(nonce);
      const hostile = () => stub({settler: EMPTY, registry: {current: EMPTY, prev: SETTLER}, code: () => true, out: 2_500_000n});

      it("the engine sends nothing (it sent the whole input there before)", async () => {
        vi.stubGlobal("fetch", hostile());
        const sent: Sent[] = [];
        const err = await caught(new ZeroExSwap2Protocol(account(sent) as never, {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: RPC}).swap2(nativeSale as never));
        expect(sent).toEqual([]);
        expect((err as Error).message).toContain(nativeText(nonce, EMPTY.toLowerCase()));
        expect(refusalOf(err)?.reason).toBe("vault_mismatch");
      });

      it("the local provider refuses the quote with what to do (vault_mismatch)", async () => {
        vi.stubGlobal("fetch", hostile());
        const heard: [string, string | undefined][] = [];
        expect(await zeroExProvider({apiKey: getKey, rpcUrls: RPC}).getQuote(nativeParams({onRefusal: (t, info) => heard.push([t, info?.reason])}))).toBeNull();
        expect(heard).toEqual([[nativeText(nonce, EMPTY.toLowerCase()), "vault_mismatch"]]);
      });

      it("the remote verifier refuses it too, classified", async () => {
        vi.stubGlobal("fetch", stub({out: 2_500_000n}));
        const honest = await zeroExProvider({apiKey: getKey, rpcUrls: RPC}).getQuote(nativeParams());
        const moved: Quote = {...honest!, txRequest: {...honest!.txRequest!, to: EMPTY}};
        const why = zeroExVerifyQuote(nativeParams(), moved, {chains: ZEROEX_CHAINS, settlers: () => [EMPTY, SETTLER]});
        expect(why).toBe(nativeText(nonce, EMPTY).replace(/^zeroex: /, ""));
        expect(zeroExRefusalReason(why!)?.reason).toBe("vault_mismatch");
      });

      it("a token sale may still use that deployment once it holds code (the margin): the permit names it, the account sends it", async () => {
        vi.stubGlobal("fetch", stub({settler: EMPTY, registry: {current: EMPTY, prev: SETTLER}, code: () => true}));
        const sent: Sent[] = [];
        const signed: {message: {spender: string}}[] = [];
        await new ZeroExSwap2Protocol(account(sent, signed) as never, {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: RPC}).swap2(tokenSale as never);
        expect(signed).toHaveLength(1);
        expect(signed[0]!.message.spender.toLowerCase()).toBe(EMPTY.toLowerCase());
        expect(sent.at(-1)!.to!.toLowerCase()).toBe(EMPTY.toLowerCase());
      });
    });
  }

  it("the pinned current and previous Settlers take native sales; checkZeroExTransaction holds the target to the pin whatever settler list it is handed", () => {
    for (const s of [SETTLER, PREV_SETTLER]) expect(() => checkZeroExTransaction(nativeTx(s), nativeExpectation([SETTLER, PREV_SETTLER], BASE))).not.toThrow();
    // without `chain`, the default table's entry for the chain is the pin
    expect(() => checkZeroExTransaction(nativeTx(SETTLER), nativeExpectation([SETTLER]))).not.toThrow();
    const refused = (tx: ReturnType<typeof nativeTx>, e: ReturnType<typeof nativeExpectation>): [string, string | undefined] => {
      try { checkZeroExTransaction(tx, e); } catch (err) { return [(err as Error).message, refusalOf(err)?.reason]; }
      return ["passed", undefined];
    };
    expect(refused(nativeTx(OLD(23)), nativeExpectation([OLD(23)], BASE))).toEqual([nativeText(23, OLD(23)), "vault_mismatch"]);
    // an integrator's table that pins 23 takes it
    expect(() => checkZeroExTransaction(nativeTx(OLD(23)), nativeExpectation([OLD(23)], {...BASE, newestLiveNonce: 23, previousLiveNonce: 22}))).not.toThrow();
    // older than the pinned previous, past the margin, or no Settler at all: not a deployment this module accepts
    for (const to of [OLD(20), OLD(BASE.newestLiveNonce + ZEROEX_SETTLER_NONCE_MARGIN + 1), "0x1035029091415555555555555555555555550001"]) {
      expect(refused(nativeTx(to), nativeExpectation([to], BASE))).toEqual([`zeroex: the transaction target ${to} is not a 0x Settler deployment this module accepts on chain 8453`, "vault_mismatch"]);
    }
    // a chain outside the table pins nothing
    expect(refused({...nativeTx(zeroExSettlerAddress(130, 1)), chainId: 130}, {...nativeExpectation([zeroExSettlerAddress(130, 1)]), chainId: 130})).toEqual(["zeroex: chain 130 is not in the 0x chain table", "unsupported_pair"]);
  });
});

// ── 2. remote mode: a fresh registry read on the device before broadcast ────

describe("2. zeroExRemoteProvider re-reads the registry on the device before broadcast", () => {
  const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
  /** The real provider behind the real handler, except that its preflight is a no-op: the backend's word is worth nothing. */
  function hostileBackend(log: string[] = []) {
    const real = zeroExProvider({apiKey: getKey, rpcUrls: RPC});
    const provider = {...real, preflightDeposit: async () => {}};
    const handle = createSwap2Handler<string>({providers: [provider as never], sealSecret: SECRET, guard: () => {}, subject: () => "alice"});
    return (async (url: string, init: RequestInit) => {
      const action = String(url).split("/").pop()!;
      log.push(action);
      const res = await handle(action, JSON.parse(String(init.body)), "alice");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
  }
  const REMOVED = "zeroex: the quoted 0x Settler is no longer in the on-chain registry. Nothing was sent; refresh the quote.";

  /** 0x removes the Settler in force while the user is on the review sheet (the registry rolls back to 21). */
  const run = async (mode: "local" | "remote") => {
    let removed = false;
    vi.stubGlobal("fetch", stub({out: 2_500_000n, onRegistryRead: () => (removed ? {current: PREV_SETTLER, prev: null} : {current: SETTLER, prev: PREV_SETTLER})}));
    const review = async () => { removed = true; };
    const sent: Sent[] = [];
    if (mode === "local") {
      const err = await caught(new ZeroExSwap2Protocol(account(sent) as never, {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: RPC, reviewExecution: review as never}).swap2(nativeSale as never));
      return {err, sent};
    }
    const provider = zeroExRemoteProvider({baseUrl: "https://backend.example/api/v2/swap2", fetchImpl: hostileBackend(), rpcUrls: RPC});
    class P extends SingleProviderSwap2 { protected readonly provider = provider; protected override chainSupported(): boolean { return true; } }
    const err = await caught(new P(account(sent) as never, {fromChain: "eip155:8453", reviewExecution: review as never}).swap2(nativeSale as never));
    return {err, sent};
  };

  for (const mode of ["local", "remote"] as const) {
    it(`${mode}: a Settler removed during review is refused at preflight, with the same text, and nothing is sent`, async () => {
      const {err, sent} = await run(mode);
      expect(sent).toEqual([]);
      expect((err as Error).message).toBe(REMOVED);
      expect(refusalOf(err)?.reason).toBe("vault_mismatch");
    });
  }

  /** A live remote quote and its build, through the hostile backend; then the provider's preflight on its own. */
  const remoteQuote = async (log: string[], settlerResolver?: SettlerResolver) => {
    vi.stubGlobal("fetch", stub({out: 2_500_000n}));
    const app = zeroExRemoteProvider({baseUrl: "https://backend.example/api/v2/swap2", fetchImpl: hostileBackend(log), rpcUrls: RPC, ...(settlerResolver ? {settlerResolver} : {})});
    const q = await app.getQuote(nativeParams());
    const tx = await app.buildDeposit(q!);
    log.length = 0;
    return {app, q: q!, tx};
  };

  it("the device read comes first (fresh), then the backend's preflight", async () => {
    const log: string[] = [];
    const real = createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC});
    const resolver: SettlerResolver = {resolve: async (id, o) => { log.push(`resolve:${o?.fresh === true ? "fresh" : "cached"}`); return real.resolve(id, o); }, known: (id) => real.known(id)};
    const {app, q, tx} = await remoteQuote(log, resolver);
    await app.preflightDeposit!(q, tx);
    expect(log).toEqual(["resolve:fresh", "preflight"]);
  });

  it("refuses before asking the backend: a Settler the registry no longer names, a transaction that is not the quote, a quote for no served chain", async () => {
    const log: string[] = [];
    const {app, q, tx} = await remoteQuote(log);
    const refusedWith = async (quote: Quote, t: UnsignedTx): Promise<[string, string | undefined]> => {
      const err = await caught(app.preflightDeposit!(quote, t));
      return [(err as Error).message, refusalOf(err)?.reason];
    };
    vi.stubGlobal("fetch", stub({registry: {current: PREV_SETTLER, prev: null}}));
    expect(await refusedWith(q, tx)).toEqual([REMOVED, "vault_mismatch"]);
    vi.stubGlobal("fetch", stub());
    expect(await refusedWith(q, {...tx, value: "1"})).toEqual(["zeroex: the transaction is not the quoted swap. Nothing was sent; refresh the quote.", "policy_refused"]);
    expect(await refusedWith({...q, intentId: q.intentId.replace(":8453:", ":130:")}, tx)).toEqual(["zeroex: the quote names no chain this provider serves. Nothing was sent.", "policy_refused"]);
    vi.stubGlobal("fetch", stub({registry: {current: null}}));
    expect((await refusedWith(q, tx))[1]).toBe("chain_halted");
    expect(log).toEqual([]);
    // and with the registry as it was, the backend is asked
    vi.stubGlobal("fetch", stub());
    await app.preflightDeposit!(q, tx);
    expect(log).toEqual(["preflight"]);
  });

  it("a native-sale quote may stay valid for at most ZEROEX_MAX_NATIVE_QUOTE_SECONDS (it passed for a year before)", async () => {
    expect(ZEROEX_MAX_NATIVE_QUOTE_SECONDS).toBe(120);
    vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(1_794_690_361_000);
    vi.stubGlobal("fetch", stub({out: 2_500_000n}));
    const local = await zeroExProvider({apiKey: getKey, rpcUrls: RPC}).getQuote(nativeParams());
    const ctx = {chains: ZEROEX_CHAINS, settlers: () => [SETTLER, PREV_SETTLER]};
    const until = (validUntilMs: number) => zeroExVerifyQuote(nativeParams(), {...local!, validUntilMs}, ctx);
    for (const ms of [365 * 24 * 3600_000, 120_001, Number.POSITIVE_INFINITY, Number.NaN]) {
      const why = until(Date.now() + ms);
      expect(why, String(ms)).toBe("the native-coin sale's quote is valid for more than 120 s");
      expect(zeroExRefusalReason(why!)?.reason).toBe("policy_refused");
    }
    expect(until(Date.now() + 120_000)).toBeNull();
    expect(until(Date.now() + 45_000)).toBeNull();
  });

  it("the local provider (the backend) never offers a native sale for longer, whatever quoteTtlMs says; token sales stay bounded by their permit", async () => {
    vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(1_794_690_361_000);
    vi.stubGlobal("fetch", stub({out: 2_500_000n}));
    const p = zeroExProvider({apiKey: getKey, rpcUrls: RPC, quoteTtlMs: 3_600_000});
    const native = await p.getQuote(nativeParams());
    expect(native!.validUntilMs).toBe(Date.now() + 90_000);
    vi.stubGlobal("fetch", stub());
    const token = await p.getQuote(tokenParams());
    expect(token!.validUntilMs).toBe(Date.now() + 300_000 - 20_000);
    expect(zeroExVerifyQuote(tokenParams(), token!, {chains: ZEROEX_CHAINS, settlers: () => [SETTLER, PREV_SETTLER]})).toBeNull();
  });

  it("a backend with a long quoteTtlMs and a clock up to 30 s ahead of the app still gets its native quote accepted", async () => {
    vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(1_794_690_361_000);
    vi.stubGlobal("fetch", stub({out: 2_500_000n}));
    const native = await zeroExProvider({apiKey: getKey, rpcUrls: RPC, quoteTtlMs: 300_000}).getQuote(nativeParams());
    const ctx = {chains: ZEROEX_CHAINS, settlers: () => [SETTLER, PREV_SETTLER]};
    for (const behind of [0, 500, 29_000]) expect(zeroExVerifyQuote(nativeParams(), native!, {...ctx, nowMs: Date.now() - behind}), String(behind)).toBeNull();
  });
});

// ── 3. replaced Settlers are refused; the table is validated ────────────────

describe("3. the oldest Settler accepted is the previous one live at pin time", () => {
  for (const nonce of [5, 12, 20]) {
    it(`Base deployment ${nonce} named as the Settler in force is refused (vault_mismatch); nothing is signed or sent`, async () => {
      vi.stubGlobal("fetch", stub({settler: OLD(nonce), registry: {current: OLD(nonce), prev: null}}));
      const err = await caught(createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC}).resolve(8453));
      expect((err as Error).message).toBe(`zeroex: the RPC on chain 8453 names ${OLD(nonce)} (Settler deployment ${nonce}) as the 0x Settler, older than the oldest this module accepts there (21) — a replaced Settler is not called`);
      expect(refusalOf(err)?.reason).toBe("vault_mismatch");
      const sent: Sent[] = [];
      const signed: {message: {spender: string}}[] = [];
      await expect(new ZeroExSwap2Protocol(account(sent, signed) as never, {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: RPC}).swap2(tokenSale as never)).rejects.toThrow(/older than the oldest this module accepts there/);
      expect(signed).toEqual([]);
      expect(sent).toEqual([]);
    });
  }

  it("a previous Settler older than the pin is dropped from the set; a registry rolled back to the pinned previous still works", async () => {
    vi.stubGlobal("fetch", stub({registry: {current: SETTLER, prev: OLD(20)}}));
    expect(await createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC}).resolve(8453)).toEqual([SETTLER]);
    vi.stubGlobal("fetch", stub({settler: PREV_SETTLER, registry: {current: PREV_SETTLER, prev: OLD(20)}, out: 2_500_000n}));
    expect(await createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC}).resolve(8453)).toEqual([PREV_SETTLER]);
    const sent: Sent[] = [];
    await new ZeroExSwap2Protocol(account(sent) as never, {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: RPC}).swap2(nativeSale as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({to: PREV_SETTLER, value: ETH_IN});
  });

  it("a token sale to an older Settler is refused by checkZeroExTransaction too, whatever settler list it is handed", async () => {
    vi.stubGlobal("fetch", stub({settler: OLD(12), registry: {current: OLD(12), prev: null}}));
    // a resolver that trusts the RPC blindly (an integrator's own): the transaction check still holds the pin
    const blind: SettlerResolver = {resolve: async () => [OLD(12)], known: () => [OLD(12)]};
    const heard: [string, string | undefined][] = [];
    expect(await zeroExProvider({apiKey: getKey, rpcUrls: RPC, settlerResolver: blind}).getQuote(tokenParams({onRefusal: (t, info) => heard.push([t, info?.reason])}))).toBeNull();
    expect(heard).toEqual([[`zeroex: the transaction target ${OLD(12).toLowerCase()} is not a 0x Settler deployment this module accepts on chain 8453`, "vault_mismatch"]]);
  });

  it("zeroExChains validates the pins of every entry; the defaults pass the same checks", () => {
    const entry = (over: Partial<ZeroExChain>): ZeroExChain => ({name: "Unichain", registry: ZEROEX_SETTLER_REGISTRY, newestLiveNonce: 4, previousLiveNonce: 3, ...over});
    expect(zeroExChains({130: entry({})})[130]).toEqual({name: "Unichain", registry: ZEROEX_SETTLER_REGISTRY, newestLiveNonce: 4, previousLiveNonce: 3});
    expect(zeroExChains({130: entry({previousLiveNonce: 4})})[130]!.previousLiveNonce).toBe(4); // a chain with one deployment so far
    const newest = /chain 130 pins no newest live Settler deployment \(newestLiveNonce, 1 to 1024\)/;
    const previous = /chain 130 pins no previous live Settler deployment \(previousLiveNonce, 1 to its newestLiveNonce\)/;
    for (const [over, why] of [
      [{newestLiveNonce: undefined}, newest], [{newestLiveNonce: 0}, newest], [{newestLiveNonce: ZEROEX_SETTLER_MAX_NONCE + 1}, newest], [{newestLiveNonce: 2.5}, newest],
      [{previousLiveNonce: undefined}, previous], [{previousLiveNonce: 0}, previous], [{previousLiveNonce: 5}, previous], [{previousLiveNonce: "3"}, previous],
    ] as const) {
      expect(() => zeroExChains({130: entry(over as never)}), JSON.stringify(over)).toThrow(why);
    }
    // the round-2 field alone pins nothing now
    expect(() => zeroExChains({130: {name: "Unichain", registry: ZEROEX_SETTLER_REGISTRY, maxSettlerNonce: 24} as never})).toThrow(newest);
    expect(zeroExChains(ZEROEX_CHAINS)).toEqual(ZEROEX_CHAINS);
  });
});

// ── 4. verify:live names a stale pin ────────────────────────────────────────

describe("4. verify:live fails on any registry state the pin does not describe, and says what to do", () => {
  it("in step: ok; a new deployment: NEW (native sales refused) or PIN (past the margin); a rollback or another previous: OLD / PREV", () => {
    const at = (current: number | null, previous: number | null) => pinStatus({id: 8453, chain: BASE, current, previous, margin: ZEROEX_SETTLER_NONCE_MARGIN});
    expect(at(22, 21)).toMatchObject({tag: "ok", native: true, token: true});
    expect(at(22, null)).toMatchObject({tag: "ok"});
    expect(at(23, 22)).toMatchObject({tag: "NEW", native: false, token: true});
    expect(at(23, 22).advice).toMatch(/0x deployed Settler 23: native-coin sales to it are refused until newestLiveNonce \/ previousLiveNonce for chain 8453 are raised in src\/chains\.ts/);
    expect(at(24, 23)).toMatchObject({tag: "NEW", native: false, token: true});
    expect(at(25, 24)).toMatchObject({tag: "PIN", native: false, token: false});
    expect(at(21, 20)).toMatchObject({tag: "OLD", native: true, token: true});
    expect(at(20, 19)).toMatchObject({tag: "OLD", native: false, token: false});
    expect(at(22, 20)).toMatchObject({tag: "PREV", native: true, token: true});
    expect(at(null, null)).toMatchObject({tag: "BAD", native: false, token: false});
    for (const s of [at(23, 22), at(25, 24), at(21, 20), at(20, 19), at(22, 20)]) expect(s.advice).toMatch(/src\/chains\.ts/);
  });
});
