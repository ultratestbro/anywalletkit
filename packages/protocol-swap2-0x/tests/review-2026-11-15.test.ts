/**
 * Review 2026-11-15 (round 2). The threat model includes a backend that also serves the app's RPC: the 0x API, the
 * backend and the RPC together must not be able to send the input anywhere but a real 0x Settler.
 *
 *  1. HIGH — a CREATE3 address of the registry that holds no contract (a deployment that does not exist yet), or a
 *     deployment newer than the chain's pin, is refused by the resolver (the reviewer's reproduction:
 *     scratch-tests/rev-undeployed-settler.test.ts, which passed — i.e. the attack worked — before this fix).
 *  2. (0x side of the core fix) every 0x call goes out with the account's own estimate; a native sale is dry-run.
 *  3. Under React Native a key is refused outright; an answer that came through a redirect is not used.
 *  4. A live remote quote is held to the Settler set its own request resolved, even when the resolver's cache ages
 *     out during the backend round trip (scratch-tests/remote-cache-race.mjs).
 *  6. Deriving Settler addresses is bounded by the chain's pin (scratch-tests/nonce-timing.mjs: 1.7 s per chain under
 *     Hermes for an address that is no Settler).
 *  7. A working `knownSpenders` recipe (scratch-tests/pins-known-doc.mjs).
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describeTypedData} from "@anywalletkit/wallet-evm";
import {parseActivityFixture, type ActivityFixtureJson} from "@anywalletkit/conformance";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ZEROEX_CHAINS, ZEROEX_SETTLER_MAX_NONCE, ZEROEX_SETTLER_NONCE_MARGIN, ZEROEX_SETTLER_REGISTRY, zeroExChains} from "../src/chains.js";
import {describeZeroExActivity} from "../src/activity.js";
import {ZeroExSwap2Protocol} from "../src/protocol.js";
import {zeroExProvider} from "../src/provider.js";
import {zeroExKnownSpenders, zeroExRemoteProvider, zeroExVerifyQuote} from "../src/remote.js";
import {createSettlerResolver, decodeSettlerExecute, zeroExSettlerAddress, zeroExSettlerNonce} from "../src/settler.js";
import {ME, PREV_SETTLER, RPC, SETTLER, USDC, getKey, permit2Typed, stub} from "./fixtures.js";
import {CURRENT_PIN_ERA, PIN_ERAS, RECORDED, UNRECORDED_PIN_ERAS, bodyOf, chainIdOf, chainsConfigOf, chainsOf, eraChains, loadRecorded, paramsOf, recordedFetch, rpcOf} from "./recorded.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const caught = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

// ── 1. undeployed and unpinned Settlers ─────────────────────────────────────

describe("1. the resolver accepts only a pinned, deployed Settler", () => {
  // The newest deployment a token sale may use on Base (round 3: a native sale only the pinned current and previous).
  const BASE_PIN = ZEROEX_CHAINS[8453]!.newestLiveNonce + ZEROEX_SETTLER_NONCE_MARGIN;
  const resolver = (o: Parameters<typeof stub>[0]) => {
    vi.stubGlobal("fetch", stub(o));
    return createSettlerResolver({chains: ZEROEX_CHAINS, rpcUrls: RPC});
  };

  it("pins the newest deployment live on 2026-11-25 (0x's 2026-11-24 release) plus a small margin on every chain", () => {
    expect(ZEROEX_SETTLER_NONCE_MARGIN).toBe(2);
    expect(Object.fromEntries(Object.entries(ZEROEX_CHAINS).map(([id, c]) => [id, c.newestLiveNonce + ZEROEX_SETTLER_NONCE_MARGIN]))).toEqual({1: 24, 10: 24, 56: 26, 137: 23, 143: 14, 8453: 25, 42161: 23, 43114: 23});
  });

  // Each recording is held to the pins of the era it was recorded in (fixtures/pin-eras.json), and the newest era is
  // the table in force. Raising a pin in src/chains.ts without adding its era fails here. So does an era that has no
  // recording but is not listed as unrecorded, and an era listed as unrecorded that has recordings.
  it("every recorded registry answer is covered by the pins of its era, margin untouched — a newer live deployment fails this and verify:live", () => {
    expect(eraChains(CURRENT_PIN_ERA)).toEqual(ZEROEX_CHAINS);
    const all = RECORDED.map(loadRecorded);
    expect(PIN_ERAS.filter((era) => !all.some((f) => f.pinEra === era)), "eras with no recording = fixtures/pin-eras.json unrecorded").toEqual(UNRECORDED_PIN_ERAS);
    for (const name of RECORDED) {
      const f = loadRecorded(name);
      const c = chainsOf(f)[chainIdOf(f)]!;
      for (const a of [f.registry.current, f.registry.prev]) {
        if (!a) continue;
        const n = zeroExSettlerNonce(chainIdOf(f), a, c.registry, c.newestLiveNonce);
        expect(n, `${name} ${a}`).not.toBeNull();
        expect(n!, `${name} ${a}`).toBe(a === f.registry.current ? c.newestLiveNonce : c.previousLiveNonce);
      }
    }
  });

  it("refuses a deployment inside the margin that holds no contract (Base 24 on 2026-11-25)", async () => {
    const empty = zeroExSettlerAddress(8453, 24);
    const err = await caught(resolver({registry: {current: empty, prev: SETTLER}}).resolve(8453));
    expect((err as Error).message).toBe(`zeroex: the RPC on chain 8453 names ${empty} (Settler deployment 24) as the 0x Settler, but no contract is deployed there`);
    expect(refusalOf(err)?.reason).toBe("vault_mismatch");
  });

  it("accepts that deployment once it holds code: 0x's next Settler works without a release, up to the pin", async () => {
    const next = zeroExSettlerAddress(8453, 24);
    expect(await resolver({registry: {current: next, prev: SETTLER}, code: () => true}).resolve(8453)).toEqual([next, SETTLER]);
    const last = zeroExSettlerAddress(8453, BASE_PIN);
    expect(await resolver({registry: {current: last, prev: null}, code: () => true}).resolve(8453)).toEqual([last]);
  });

  it("refuses a deployment newer than the pin with what to do — even when it holds code", async () => {
    const newer = zeroExSettlerAddress(8453, BASE_PIN + 1);
    const err = await caught(resolver({registry: {current: newer, prev: SETTLER}, code: () => true}).resolve(8453));
    expect((err as Error).message).toBe(`zeroex: the 0x registry on chain 8453 names Settler deployment ${BASE_PIN + 1} (${newer}), newer than the newest this module accepts there (${BASE_PIN}) — update @anywalletkit/protocol-swap2-0x, or raise the chain's newestLiveNonce and previousLiveNonce once that deployment is checked`);
    expect(refusalOf(err)?.reason).toBe("vault_mismatch");
    // far past the pin it is no Settler this module can tell at all (the reviewer's nonce 1000)
    const far = zeroExSettlerAddress(8453, 1000);
    await expect(resolver({registry: {current: far, prev: null}, code: () => true}).resolve(8453)).rejects.toThrow(`names ${far} as the 0x Settler, which is not an address the 0x registry deploys Settlers to`);
  });

  it("drops a previous Settler without code or past the pin, and refuses when the code cannot be read", async () => {
    expect(await resolver({registry: {prev: zeroExSettlerAddress(8453, 24)}}).resolve(8453)).toEqual([SETTLER]);
    expect(await resolver({registry: {prev: zeroExSettlerAddress(8453, BASE_PIN + 1)}, code: () => true}).resolve(8453)).toEqual([SETTLER]);
    const err = await caught(resolver({code: null}).resolve(8453));
    expect((err as Error).message).toBe("zeroex: the RPC on chain 8453 could not read the 0x Settler's code");
    expect(refusalOf(err)?.reason).toBe("upstream_unavailable");
  });

  it("a chain table entry must pin its newest Settler deployment", () => {
    expect(() => zeroExChains({130: {name: "Unichain", registry: ZEROEX_SETTLER_REGISTRY} as never})).toThrow(/chain 130 pins no newest live Settler deployment \(newestLiveNonce, 1 to 1024\)/);
    expect(() => zeroExChains({130: {name: "Unichain", registry: ZEROEX_SETTLER_REGISTRY, newestLiveNonce: ZEROEX_SETTLER_MAX_NONCE + 1, previousLiveNonce: 1}})).toThrow(/pins no newest live Settler deployment/);
    expect(zeroExChains({130: {name: "Unichain", registry: ZEROEX_SETTLER_REGISTRY, newestLiveNonce: 3, previousLiveNonce: 2}})[130]!.newestLiveNonce).toBe(3);
  });

  // The reviewer's reproduction (a real native sale; backend = RPC + API): before this fix every step below passed and
  // the engine sent the native input to the empty address. It runs on the recording's own pin era (Base 22 / 21, where
  // 23 was the next deployment, not made yet).
  for (const nonce of [23, 1000]) {
    describe(`the reviewer's attack: Base deployment ${nonce} named by a hostile RPC and API`, () => {
      const f = loadRecorded("base-eth-usdc");
      const EMPTY = zeroExSettlerAddress(8453, nonce);
      const hostile = () => { const b = bodyOf(f); b.transaction.to = EMPTY; return b; };

      it("the resolver refuses it", async () => {
        vi.stubGlobal("fetch", recordedFetch(f, {registry: {current: EMPTY, prev: null}}));
        const err = await caught(createSettlerResolver({chains: chainsOf(f), rpcUrls: rpcOf(f)}).resolve(8453));
        expect(refusalOf(err)?.reason).toBe("vault_mismatch");
      });

      it("the local provider refuses the quote before asking the API", async () => {
        vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(f.request.nowMs);
        const seen: {url: string; method: string}[] = [];
        vi.stubGlobal("fetch", recordedFetch(f, {seen, body: hostile(), registry: {current: EMPTY, prev: null}}));
        const heard: [string, string | undefined][] = [];
        const q = await zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)}).getQuote(paramsOf(f, {onRefusal: (t, info) => heard.push([t, info?.reason])}));
        expect(q).toBeNull();
        expect(heard).toHaveLength(1);
        expect(heard[0]![1]).toBe("vault_mismatch");
        expect(seen.filter((s) => s.method === "GET")).toEqual([]);
      });

      it("the engine sends nothing", async () => {
        vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(f.request.nowMs);
        vi.stubGlobal("fetch", recordedFetch(f, {body: hostile(), registry: {current: EMPTY, prev: null}}));
        const sent: unknown[] = [];
        const account = {
          getAddress: async () => f.request.refundAddress, getChainId: async () => 8453, getBalance: async () => 10n ** 18n, getAllowance: async () => 0n,
          quoteSendTransaction: async () => ({fee: 1n}), waitForTransaction: async () => {},
          sendTransaction: async (t: unknown) => { sent.push(t); return {hash: `0x${"1".repeat(64)}`}; },
        };
        const e = decodeSettlerExecute(f.response.transaction.data);
        await expect(new ZeroExSwap2Protocol(account as never, {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)})
          .swap2({fromToken: "ETH", toToken: f.request.destToken, toChain: 8453, recipient: f.request.refundAddress, fromTokenAmount: BigInt(f.request.amountIn), minAmountOut: e.minAmountOut, slippageBps: 50} as never)).rejects.toThrow();
        expect(sent).toEqual([]);
      });
    });
  }
});

// ── 2. the account's own gas estimate (0x side) ─────────────────────────────

describe("2. every 0x call goes out with the account's own gas estimate", () => {
  it("both providers declare ownGasEstimate", () => {
    expect(zeroExProvider({apiKey: getKey, rpcUrls: RPC}).ownGasEstimate).toBe(true);
    expect(zeroExRemoteProvider({baseUrl: "https://backend.example/api", rpcUrls: RPC}).ownGasEstimate).toBe(true);
  });

  it("a native sale is dry-run from the account and sent without the quoted gas limit; one that reverts is not sent", async () => {
    const run = async (reverts: boolean) => {
      vi.stubGlobal("fetch", stub({out: 2_500_000n}));
      const sent: {to?: string; value?: bigint; gasLimit?: bigint}[] = [];
      const dryRuns: unknown[] = [];
      const account = {
        getAddress: async () => ME, getChainId: async () => 8453, getBalance: async () => 10n ** 18n, getAllowance: async () => 0n, waitForTransaction: async () => {},
        quoteSendTransaction: async (t: {to?: string; gasLimit?: bigint}) => {
          if (t.to === SETTLER && t.gasLimit === undefined) {
            dryRuns.push(t);
            if (reverts) throw Object.assign(new Error("execution reverted"), {name: "ExecutionRevertedError"});
          }
          return {fee: 1n};
        },
        sendTransaction: async (t: {to?: string; value?: bigint; gasLimit?: bigint}) => { sent.push(t); return {hash: `0x${"1".repeat(64)}`}; },
      };
      const swap = new ZeroExSwap2Protocol(account as never, {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: RPC})
        .swap2({fromToken: "ETH", toToken: USDC, toChain: 8453, recipient: ME, fromTokenAmount: 10n ** 15n, minAmountOut: 2_487_500n});
      return {result: await swap.then(() => null, (e: unknown) => e), sent, dryRuns};
    };
    const ok = await run(false);
    expect(ok.result).toBeNull();
    expect(ok.dryRuns).toHaveLength(1);
    expect(ok.sent).toHaveLength(1);
    expect(ok.sent[0]).toMatchObject({to: SETTLER, value: 10n ** 15n});
    expect(ok.sent[0]!.gasLimit).toBeUndefined();
    const bad = await run(true);
    expect((bad.result as Error).message).toMatch(/^swap2: the swap does not simulate from this account \(execution reverted\) — nothing was sent$/);
    expect(refusalOf(bad.result)?.reason).toBe("simulation_failed");
    expect(bad.sent).toEqual([]);
  });
});

// ── 3. the key is server-only ───────────────────────────────────────────────

describe("3. the API key stays on a server", () => {
  it("under React Native (navigator.product) or Hermes (HermesInternal) a provider with a key is refused, pointing to the remote mode", () => {
    for (const [name, value] of [["navigator", {product: "ReactNative"}], ["HermesInternal", {}]] as const) {
      vi.stubGlobal(name, value);
      for (const apiKey of [getKey, "a-key-as-a-string"]) {
        expect(() => zeroExProvider({apiKey, rpcUrls: RPC})).toThrow(/the 0x API key belongs on a server .*zeroExRemoteProvider\(\{baseUrl, rpcUrls\}\) in the app/);
        expect(() => new ZeroExSwap2Protocol(undefined, {fromChain: "eip155:8453", apiKey, rpcUrls: RPC})).toThrow(/belongs on a server/);
      }
      // without a key it builds (and serves no route); the remote provider is what an app runs
      expect(zeroExProvider({rpcUrls: RPC}).supportsChain!("eip155:8453")).toBe(false);
      expect(zeroExRemoteProvider({baseUrl: "https://backend.example/api", rpcUrls: RPC}).supportsChain!("eip155:8453")).toBe(true);
      vi.unstubAllGlobals();
    }
    expect(() => zeroExProvider({apiKey: getKey, rpcUrls: RPC})).not.toThrow();
  });

  const answered = (over: {redirected?: boolean; url?: (requested: string) => string}) => {
    const inner = stub();
    vi.stubGlobal("fetch", (async (input: string | URL, init?: {method?: string}) => {
      const res = await inner(input as string, init as never);
      if ((init?.method ?? "GET") !== "GET") return res;
      // What a fetch that followed a redirect (React Native ignores `redirect: "error"`) hands back.
      return {status: res.status, ok: res.ok, headers: res.headers, redirected: over.redirected ?? false, url: over.url ? over.url(String(input)) : String(input), text: () => res.text()};
    }) as unknown as typeof fetch);
    const heard: [string, string | undefined][] = [];
    const quote = () => zeroExProvider({apiKey: getKey, rpcUrls: RPC}).getQuote({sourceChain: "eip155:8453", destChain: "eip155:8453", sourceToken: "USDC", destToken: "0x0000000000000000000000000000000000000000", amountIn: "1000000", destAddress: ME, refundAddress: ME, slippageBps: 100, dry: false, onRefusal: (t, info) => heard.push([t, info?.reason])} as QuoteParams);
    return {quote, heard};
  };

  it("an answer that came through a redirect, or from another origin, is not used (policy_refused)", async () => {
    for (const over of [{redirected: true}, {url: () => "https://evil.example/swap/permit2/quote"}, {url: (u: string) => u.replace("https://api.0x.org", "http://api.0x.org")}]) {
      const s = answered(over);
      expect(await s.quote()).toBeNull();
      expect(s.heard).toEqual([["zeroex: the API answer came through a redirect or from another origin — refused (the key must not follow one)", "policy_refused"]]);
    }
    const same = answered({});
    expect(await same.quote()).not.toBeNull();
  });
});

// ── 4. a remote quote is held to its own request's Settler set ─────────────

describe("4. a slow backend does not age a live quote's Settler set out from under it", () => {
  const f = loadRecorded("base-eth-usdc");
  const r = f.request;
  const t = f.response.transaction;
  const params: QuoteParams = {sourceChain: r.sourceChain, destChain: r.sourceChain, sourceToken: r.sourceToken, destToken: r.destToken, amountIn: r.amountIn, slippageBps: 50, destAddress: r.destAddress, refundAddress: r.refundAddress, dry: false};
  const answer = (): Quote => ({provider: "zeroex", intentId: `zeroex:8453:x~${"a".repeat(32)}`, depositAddress: "", depositMemo: null, sourceAmount: r.amountIn, destAmount: f.response.buyAmount, minDestAmount: f.response.minBuyAmount, feeUsd: 0, etaSeconds: 15, reliability: 0.96, validUntilMs: Date.now() + 45_000, txRequest: {to: t.to, data: t.data, value: t.value, chainId: 8453}});
  /** The resolver's cache is 4 min 59 s old when the quote is asked for; the backend takes `latencyMs` (clock injected). */
  const setup = async (latencyMs: number) => {
    vi.stubGlobal("fetch", recordedFetch(f));
    let clock = 1_000_000;
    const resolver = createSettlerResolver({chains: chainsOf(f), rpcUrls: rpcOf(f), now: () => clock});
    await resolver.resolve(8453);
    clock += 300_000 - 1_000;
    const backend = (async () => { clock += latencyMs; return new Response(JSON.stringify(answer()), {status: 200}); }) as unknown as typeof fetch;
    const app = zeroExRemoteProvider({baseUrl: "https://backend.invalid/api/swap2", fetchImpl: backend, settlerResolver: resolver, chains: chainsConfigOf(f)});
    return {app, resolver, crossed: () => resolver.known(8453).length === 0};
  };

  it("the quote passes when the cache ages out during the backend call (it failed with 'not resolved' before)", async () => {
    const s = await setup(2_000);
    const q = await s.app.getQuote(params);
    expect(s.crossed()).toBe(true);
    expect(q?.txRequest?.to).toBe(t.to);
  });

  it("…through the router too: its pin check (callTargets) holds the quote's own set while the quote lives", async () => {
    const s = await setup(2_000);
    const router = new CrossChainRouter([s.app]);
    const best = await router.getBestQuote(params);
    expect(s.crossed()).toBe(true);
    expect(router.lastRejections).toEqual([]);
    expect(best?.provider).toBe("zeroex");
    expect(s.app.callTargets!("eip155:8453").map((a) => a.toLowerCase())).toContain(t.to.toLowerCase());
  });

  it("the per-request set is still the device's own read: a Settler it never resolved stays refused", async () => {
    const s = await setup(2_000);
    const foreign = answer();
    foreign.txRequest!.to = zeroExSettlerAddress(8453, 5);
    const app = zeroExRemoteProvider({baseUrl: "https://backend.invalid/api/swap2", fetchImpl: (async () => new Response(JSON.stringify(foreign), {status: 200})) as unknown as typeof fetch, settlerResolver: s.resolver, chains: chainsConfigOf(f)});
    await expect(app.getQuote(params)).rejects.toThrow(/is not a 0x Settler from the on-chain registry/);
    expect(zeroExVerifyQuote(params, answer(), {chains: chainsOf(f), settlers: () => []})).toMatch(/is not resolved/);
  });
});

// ── 6. bounded derivation ───────────────────────────────────────────────────

describe("6. deriving Settler addresses stops at the chain's pin", () => {
  it("an address past the pin is not derived to (it used to be, up to 1024)", () => {
    const pin = ZEROEX_CHAINS[8453]!.newestLiveNonce + ZEROEX_SETTLER_NONCE_MARGIN;
    expect(zeroExSettlerNonce(8453, zeroExSettlerAddress(8453, pin))).toBe(pin);
    expect(zeroExSettlerNonce(8453, zeroExSettlerAddress(8453, pin + 1))).toBeNull();
    expect(zeroExSettlerNonce(8453, zeroExSettlerAddress(8453, 100))).toBeNull();
    expect(zeroExSettlerNonce(8453, zeroExSettlerAddress(8453, 100), ZEROEX_SETTLER_REGISTRY, 100)).toBe(100);
    // a chain outside the default table has no pin: nothing is a Settler there unless the caller names one
    expect(zeroExSettlerNonce(130, zeroExSettlerAddress(130, 1))).toBeNull();
    expect(zeroExSettlerNonce(130, zeroExSettlerAddress(130, 1), ZEROEX_SETTLER_REGISTRY, 3)).toBe(1);
  });

  it("history: an execute call to a far CREATE3 address of the registry is not labelled a 0x swap", () => {
    const fixture = parseActivityFixture(JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/activity/base-permit2-transfer-from.json", import.meta.url)), "utf8")) as ActivityFixtureJson);
    expect(describeZeroExActivity(fixture.tx, {own: fixture.own})).not.toBeNull();
    const far = zeroExSettlerAddress(8453, 500);
    const moved = {...fixture.tx, to: far, ...(fixture.tx.call ? {call: {...fixture.tx.call, to: far}} : {})};
    expect(describeZeroExActivity(moved, {own: fixture.own})).toBeNull();
  });

  it("a miss on every chain of the table is cheap (node; Hermes measured 1.7 s per chain before)", () => {
    const start = performance.now();
    for (const id of Object.keys(ZEROEX_CHAINS)) expect(zeroExSettlerNonce(Number(id), "0x1111111111111111111111111111111111111111")).toBeNull();
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

// ── 7. the knownSpenders recipe ─────────────────────────────────────────────

describe("7. knownSpenders for signing policies", () => {
  it("zeroExKnownSpenders(provider, chainId) labels the Settlers the provider's own resolver reads — and describeTypedData then knows the spender", async () => {
    vi.stubGlobal("fetch", stub());
    const app = zeroExRemoteProvider({baseUrl: "https://backend.example/api", rpcUrls: RPC});
    const known = await zeroExKnownSpenders(app, 8453);
    expect(known).toEqual({[SETTLER]: "0x Settler", [PREV_SETTLER]: "0x Settler"});
    expect(await zeroExKnownSpenders(zeroExProvider({apiKey: getKey, rpcUrls: RPC}), 8453)).toEqual(known);
    expect(await zeroExKnownSpenders(app.settlerResolver, 8453, "0x")).toEqual({[SETTLER]: "0x", [PREV_SETTLER]: "0x"});

    const typed = permit2Typed({spender: SETTLER});
    const without = describeTypedData(typed as never, {chainId: 8453, account: ME});
    expect(without.warnings.map((w) => w.code)).toContain("spender-unknown");
    const withKnown = describeTypedData(typed as never, {chainId: 8453, account: ME, knownSpenders: known});
    expect(withKnown.kind).toBe("permit2");
    expect(withKnown.permit2?.spenderLabel).toBe("0x Settler");
    expect(withKnown.warnings.map((w) => w.code)).not.toContain("spender-unknown");
  });

  it("is empty — never trusting — when the registry cannot be read", async () => {
    vi.stubGlobal("fetch", stub({rpcDown: true}));
    expect(await zeroExKnownSpenders(zeroExRemoteProvider({baseUrl: "https://backend.example/api", rpcUrls: RPC}), 8453)).toEqual({});
  });

  it("the old recipe (a fresh zeroExPins().resolver.known) was empty: the provider's resolver is the one that has read", async () => {
    vi.stubGlobal("fetch", stub());
    const app = zeroExRemoteProvider({baseUrl: "https://backend.example/api", rpcUrls: RPC});
    expect(app.settlerResolver.known(8453)).toEqual([]);
    await zeroExKnownSpenders(app, 8453);
    expect(app.settlerResolver.known(8453)).toEqual([SETTLER, PREV_SETTLER]);
  });
});
