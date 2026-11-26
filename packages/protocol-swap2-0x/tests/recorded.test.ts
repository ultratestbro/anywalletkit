/**
 * Real 0x answers through every check the device runs (fixtures/quotes: recorded 2026-11-15 on the first seven chains, pin
 * era 2026-11-15, and 2026-11-26 on all eight, pin era 2026-11-25 — where 0x quoted the registry's previous Settler on every chain):
 * the provider's parser, the Settler check, the Permit2 rebuild against 0x's own hash, the engine's quote validation,
 * the remote-mode verifiers, build and preflight, and a full swap through the engine. A future change in 0x's answer
 * shape, or a check that is too strict for what 0x really sends, fails here instead of in production. Each recording is
 * replayed with the chain table of the pin era it was recorded in (tests/recorded.ts, fixtures/pin-eras.json).
 */
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {getAddress} from "viem";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {quoteRejection} from "@anywalletkit/protocol-swap2-core/validate";
import {ZEROEX_CHAINS, ZEROEX_PERMIT2} from "../src/chains.js";
import {ZeroExSwap2Protocol} from "../src/protocol.js";
import {zeroExProvider} from "../src/provider.js";
import {zeroExRemoteProvider, zeroExVerifyBuild, zeroExVerifyQuote} from "../src/remote.js";
import {SETTLER_NATIVE_CHECK_SELECTOR, SETTLER_PERMIT_ACTIONS, checkZeroExTransaction, createSettlerResolver, decodeSettlerExecute, zeroExSettlerNonce} from "../src/settler.js";
import {getKey} from "./fixtures.js";
import {CURRENT_PIN_ERA, PIN_ERAS, RECORDED, UNRECORDED_CHAINS, UNRECORDED_PIN_ERAS, chainIdOf, chainOf, chainsConfigOf, chainsOf, eraChains, eraPins, loadRecorded, nativeSale, paramsOf, recordedFetch, recordedQuery, rpcOf, type RecordedQuote, type Seen} from "./recorded.js";

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"]}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function quoted(f: RecordedQuote, over: Partial<QuoteParams> = {}) {
  vi.setSystemTime(f.request.nowMs);
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", recordedFetch(f, {seen}));
  const refusals: {text: string; reason: string | undefined}[] = [];
  const provider = zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f), ...(f.request.excludedSources ? {excludedSources: f.request.excludedSources} : {})});
  const params = paramsOf(f, {onRefusal: (text, info) => refusals.push({text, reason: info?.reason}), ...over});
  const quote = await provider.getQuote(params);
  return {provider, params, quote, refusals, seen};
}
const ctxOf = (f: RecordedQuote) => ({chains: chainsOf(f), settlers: () => [f.registry.current, ...(f.registry.prev ? [f.registry.prev] : [])], nowMs: f.request.nowMs});

describe("the recordings", () => {
  it("cover every chain of every era, the table in force included: a token sale, a native sale and an indicative price each", () => {
    const all = RECORDED.map(loadRecorded);
    // the table in force is the newest era's: every one of its chains (Monad too) has real 0x answers in that era
    expect(Object.keys(eraPins(CURRENT_PIN_ERA)).map(Number).sort((a, b) => a - b)).toEqual(Object.keys(ZEROEX_CHAINS).map(Number).sort((a, b) => a - b));
    expect(new Set(all.filter((f) => f.pinEra === CURRENT_PIN_ERA).map(chainIdOf))).toEqual(new Set(Object.keys(ZEROEX_CHAINS).map(Number)));
    for (const era of PIN_ERAS) {
      const inEra = all.filter((f) => f.pinEra === era);
      // a recording names a chain of its own era's table only
      for (const f of inEra) expect(eraPins(era)[chainIdOf(f)], `${f.name}: chain ${chainIdOf(f)} is not in era ${era}`).toBeDefined();
      for (const id of Object.keys(eraPins(era)).map(Number)) {
        const on = inEra.filter((f) => chainIdOf(f) === id && !f.refusal);
        expect(on.some((f) => !f.request.dry && !nativeSale(f)), `${era}: token sale on ${id}`).toBe(true);
        expect(on.some((f) => !f.request.dry && nativeSale(f)), `${era}: native sale on ${id}`).toBe(true);
        expect(on.some((f) => f.request.dry), `${era}: indicative price on ${id}`).toBe(true);
      }
    }
  });
  it("name, as the Settlers in force, only addresses the 0x registry deploys to (CREATE3, computed offline)", () => {
    for (const f of RECORDED.map(loadRecorded)) {
      expect(zeroExSettlerNonce(chainIdOf(f), f.registry.current), f.name).not.toBeNull();
      if (f.registry.prev) expect(zeroExSettlerNonce(chainIdOf(f), f.registry.prev), f.name).not.toBeNull();
    }
  });
  it("each names a pin era; the newest era is the chain table in force, and pins only move forward from era to era", () => {
    for (const f of RECORDED.map(loadRecorded)) expect(PIN_ERAS, f.name).toContain(f.pinEra);
    expect(eraChains(CURRENT_PIN_ERA)).toEqual(ZEROEX_CHAINS);
    expect([...PIN_ERAS].sort()).toEqual(PIN_ERAS);
    for (let i = 1; i < PIN_ERAS.length; i++) {
      const [before, after] = [eraPins(PIN_ERAS[i - 1]!), eraPins(PIN_ERAS[i]!)];
      for (const [id, [newest, previous]] of Object.entries(before)) {
        const next = after[Number(id)];
        if (!next) continue;
        expect(next[0], `${PIN_ERAS[i]} chain ${id} newest`).toBeGreaterThanOrEqual(newest);
        expect(next[1], `${PIN_ERAS[i]} chain ${id} previous`).toBeGreaterThanOrEqual(previous);
      }
    }
  });
  it("no era and no chain is listed as unrecorded — and only the era in force, or a chain first in it, ever could be", () => {
    // Both lists are held empty: every era, and every chain of the table, has its recordings (above). An era is
    // recordable only while 0x still quotes its Settlers and the registry still names its pins, so were the lists ever
    // used again, a superseded era (or a chain already in an earlier era) listed there would ship without a real 0x
    // answer for good.
    expect(UNRECORDED_PIN_ERAS).toEqual([]);
    expect(UNRECORDED_CHAINS).toEqual([]);
    for (const era of UNRECORDED_PIN_ERAS) expect(era, `${era} is unrecorded but no longer the era in force`).toBe(CURRENT_PIN_ERA);
    for (const id of UNRECORDED_CHAINS) {
      expect(eraPins(CURRENT_PIN_ERA)[id], `${id} is listed as unrecorded but is not in the era in force`).toBeDefined();
      for (const era of PIN_ERAS.slice(0, -1)) expect(eraPins(era)[id], `${id} is listed as unrecorded but was already in ${era}`).toBeUndefined();
    }
  });
  it("every era is recorded, on each of its chains", () => {
    const all = RECORDED.map(loadRecorded);
    expect(PIN_ERAS.filter((era) => !all.some((f) => f.pinEra === era))).toEqual([]);
    for (const era of PIN_ERAS) {
      for (const id of Object.keys(eraPins(era)).map(Number)) expect(all.some((f) => f.pinEra === era && chainIdOf(f) === id), `${era} chain ${id}`).toBe(true);
    }
  });
});

describe.each(RECORDED)("%s", (name) => {
  const f = loadRecorded(name);
  const live = !f.request.dry;

  it("the provider asks 0x exactly what was recorded, with the key only in a header", async () => {
    const {seen} = await quoted(f);
    const api = seen.filter((s) => s.method === "GET");
    expect(api).toHaveLength(1);
    const url = new URL(api[0]!.url);
    expect(url.pathname).toBe(f.request.endpoint);
    expect(Object.fromEntries(url.searchParams)).toEqual(recordedQuery(f));
  });

  if (f.refusal) {
    it(`is refused: ${f.refusal}`, async () => {
      const {quote, refusals} = await quoted(f);
      expect(quote).toBeNull();
      expect(refusals.map((r) => r.text)).toEqual([f.refusal]);
      expect(refusals[0]!.reason).toBeDefined();
    });
    return;
  }

  it("passes the provider's parser and checks, and the engine's quote validation", async () => {
    const {quote, params, refusals} = await quoted(f);
    expect(refusals).toEqual([]);
    expect(quote).not.toBeNull();
    const q = quote!;
    expect(q.sourceAmount).toBe(f.request.amountIn);
    expect(q.destAmount).toBe(f.response.buyAmount);
    expect(q.minDestAmount).toBe(f.response.minBuyAmount);
    expect(q.fees!.some((fee) => fee.type === "protocol" && fee.included)).toBe(true); // 0x's fee, shown
    expect(quoteRejection(q, params, "zeroex")).toBeNull();
    expect(q.validUntilMs).toBeGreaterThan(f.request.nowMs);
    if (!live) {
      expect(q.txRequest).toBeUndefined();
      return;
    }
    const tx = q.txRequest!;
    expect(tx.to).toBe(getAddress(f.response.transaction.to));
    expect(tx.data).toBe(f.response.transaction.data);
    expect(tx.value).toBe(f.response.transaction.value);
    expect(tx.chainId).toBe(chainIdOf(f));
    const execute = decodeSettlerExecute(tx.data!);
    expect(execute.recipient.toLowerCase()).toBe(f.request.destAddress.toLowerCase());
    expect(execute.minAmountOut).toBe(BigInt(f.response.minBuyAmount));
    if (nativeSale(f)) {
      // 0x names Permit2 as allowanceTarget on native sales too; nothing is approved or signed.
      expect(f.response.allowanceTarget.toLowerCase()).toBe(ZEROEX_PERMIT2.toLowerCase());
      expect(tx.approvalAddress).toBeUndefined();
      expect(tx.permit2Transfer).toBeUndefined();
      expect(tx.value).toBe(f.request.amountIn);
      expect(execute.actions[0]!.selector).toBe(SETTLER_NATIVE_CHECK_SELECTOR);
    } else {
      expect(tx.approvalAddress).toBe(getAddress(ZEROEX_PERMIT2));
      expect(SETTLER_PERMIT_ACTIONS[execute.actions[0]!.selector]).toBeDefined();
      const permit = JSON.parse(tx.permit2Transfer!) as {message: {permitted: {token: string; amount: string}; spender: string; deadline: string}};
      expect(permit.message.permitted).toEqual({token: f.request.sourceToken.toLowerCase(), amount: f.request.amountIn});
      expect(permit.message.spender).toBe(tx.to!.toLowerCase());
      // the quote lapses before the signature it asks for does
      expect(q.validUntilMs).toBeLessThanOrEqual(Number(permit.message.deadline) * 1000);
    }
  });

  it("passes the device's own checks in remote mode (quote, server-tagged quote, build) and preflight", async () => {
    const {provider, quote, params} = await quoted(f);
    const q = quote!;
    expect(zeroExVerifyQuote(params, q, ctxOf(f))).toBeNull();
    expect(zeroExVerifyQuote(params, {...q, intentId: `${q.intentId}~${"a".repeat(32)}`}, ctxOf(f))).toBeNull();
    if (!live) return;
    const tx = await provider.buildDeposit(q);
    const resolver = createSettlerResolver({chains: chainsOf(f), rpcUrls: rpcOf(f)});
    expect(await zeroExVerifyBuild(q, tx, params, {...ctxOf(f), resolver})).toBeNull();
    await expect(provider.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    checkZeroExTransaction(tx, {chainId: chainIdOf(f), chain: chainOf(f), settlers: ctxOf(f).settlers(), sellToken: f.request.sourceToken, buyToken: f.request.destToken, sellAmount: BigInt(f.request.amountIn), recipient: f.request.destAddress, minBuyAmount: BigInt(f.response.minBuyAmount), nowMs: f.request.nowMs});
  });

  if (live) {
    it("is refused for another recipient, a lower floor breach, or a Settler the registry does not name", async () => {
      const {quote, params} = await quoted(f);
      const other = "0x1111111111111111111111111111111111111111";
      const text = zeroExVerifyQuote({...params, destAddress: other}, quote!, ctxOf(f));
      expect(text).toMatch(/not the recipient of this swap/);
      expect(zeroExVerifyQuote({...params, minAmountOut: (BigInt(f.response.minBuyAmount) + 1n).toString()}, quote!, ctxOf(f))).toMatch(/below the caller's floor/);
      // The registry's other Settler (current or previous, whichever 0x did not quote), else a foreign address: resolved,
      // but not the target. A recording that 0x sent to the previous Settler is held to the current one alone here.
      const to = quote!.txRequest!.to!.toLowerCase();
      const notTheTarget = [f.registry.current, f.registry.prev, other].filter((s): s is string => !!s && s.toLowerCase() !== to);
      expect(zeroExVerifyQuote(params, quote!, {...ctxOf(f), settlers: () => [notTheTarget[0]!]})).toMatch(/is not a 0x Settler from the on-chain registry/);
    });
  }
});

describe("through the engine and the server, on real answers", () => {
  const TAKER = "0x97fE145E77364FE3B113b2192d6DCd0C6C121273";
  const SIG = `0x${"ab".repeat(65)}`;
  function account(log: {sent: {to?: string; data?: string; value?: bigint; gasLimit?: bigint}[]; signed: unknown[]}) {
    return {
      getAddress: async () => TAKER, getChainId: async () => 8453, getBalance: async () => 10n ** 18n, getAllowance: async () => 0n,
      quoteSendTransaction: async () => ({fee: 1n}), waitForTransaction: async () => {},
      signTypedData: async (t: unknown) => { log.signed.push(t); return SIG; },
      sendTransaction: async (t: {to?: string; data?: string; value?: bigint}) => { log.sent.push(t); return {hash: `0x${String(log.sent.length).padStart(64, "0")}`}; },
    };
  }

  it("Base USDC → ETH: exact approval to Permit2, the recorded permit signed, the recorded call sent with the signature appended", async () => {
    const f = loadRecorded("base-usdc-eth");
    vi.setSystemTime(f.request.nowMs);
    vi.stubGlobal("fetch", recordedFetch(f));
    const log = {sent: [] as {to?: string; data?: string; value?: bigint; gasLimit?: bigint}[], signed: [] as unknown[]};
    let plan: Swap2ExecutionPlan | undefined;
    const protocol = new ZeroExSwap2Protocol(account(log) as never, {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f), reviewExecution: (p) => { plan = p; }});
    await protocol.swap2({fromToken: "USDC", toToken: f.request.destToken, toChain: 8453, recipient: TAKER, fromTokenAmount: BigInt(f.request.amountIn), minAmountOut: BigInt(f.response.minBuyAmount), slippageBps: 50} as never);
    expect(plan!.approvals).toEqual([expect.objectContaining({spender: getAddress(ZEROEX_PERMIT2), amount: BigInt(f.request.amountIn)})]);
    expect(log.signed).toHaveLength(1);
    expect((log.signed[0] as {message: unknown}).message).toEqual({...f.response.permit2.eip712.message, permitted: {token: f.response.permit2.eip712.message.permitted.token.toLowerCase(), amount: f.request.amountIn}, spender: f.response.transaction.to.toLowerCase()});
    expect(log.sent).toHaveLength(2);
    expect(log.sent[1]!.data).toBe(`${f.response.transaction.data}${(65).toString(16).padStart(64, "0")}${SIG.slice(2)}`);
    expect(log.sent[1]!.gasLimit).toBeUndefined();
  });

  it("Base ETH → USDC: value = the amount sold, no approval, no signature", async () => {
    const f = loadRecorded("base-eth-usdc");
    vi.setSystemTime(f.request.nowMs);
    vi.stubGlobal("fetch", recordedFetch(f));
    const log = {sent: [] as {to?: string; data?: string; value?: bigint}[], signed: [] as unknown[]};
    const protocol = new ZeroExSwap2Protocol(account(log) as never, {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)});
    await protocol.swap2({fromToken: "ETH", toToken: f.request.destToken, toChain: 8453, recipient: TAKER, fromTokenAmount: BigInt(f.request.amountIn), minAmountOut: BigInt(f.response.minBuyAmount), slippageBps: 50} as never);
    expect(log.signed).toEqual([]);
    expect(log.sent).toEqual([expect.objectContaining({to: getAddress(f.response.transaction.to), data: f.response.transaction.data, value: BigInt(f.request.amountIn)})]);
  });

  it.each(["base-usdc-eth", "base-eth-usdc"])("%s: the real provider behind createSwap2Handler, checked again on the device by zeroExRemoteProvider", async (name) => {
    const f = loadRecorded(name);
    vi.setSystemTime(f.request.nowMs);
    const upstream = recordedFetch(f);
    vi.stubGlobal("fetch", upstream);
    const handle = createSwap2Handler<string>({providers: [zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)})], sealSecret: "recorded-test-seal-secret-at-least-32-bytes", guard: () => {}, subject: () => "alice"});
    const backend = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "user");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const app = zeroExRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend, rpcUrls: rpcOf(f), chains: chainsConfigOf(f)});
    const params = paramsOf(f);
    const q = await app.getQuote(params);
    expect(q).not.toBeNull();
    const tx = await app.buildDeposit(q!);
    expect(tx.to).toBe(getAddress(f.response.transaction.to));
    expect(tx.permit2Transfer === undefined).toBe(nativeSale(f));
    expect(refusalOf(await app.buildDeposit({...q!, txRequest: {...q!.txRequest!, data: `${q!.txRequest!.data!}00`}}).catch((e: unknown) => e))).toBeDefined();
  });
});

describe("pin era 2026-11-25, recorded 2026-11-26: 0x quoted the registry's previous Settler on every chain", () => {
  const era = RECORDED.map(loadRecorded).filter((f) => f.pinEra === "2026-11-25");
  const live = era.filter((f) => !f.request.dry);

  it("all eight chains, each live answer sent to prev(2) — the era's pinned previous deployment, which the registry still named", () => {
    expect(new Set(era.map(chainIdOf))).toEqual(new Set([1, 10, 56, 137, 143, 8453, 42161, 43114]));
    expect(live.length).toBeGreaterThanOrEqual(17);
    for (const f of live) {
      const c = chainOf(f);
      expect(f.registry.prev, f.name).not.toBeNull();
      expect(f.response.transaction.to.toLowerCase(), f.name).toBe(f.registry.prev!.toLowerCase());
      expect(zeroExSettlerNonce(chainIdOf(f), f.response.transaction.to, c.registry, c.newestLiveNonce), f.name).toBe(c.previousLiveNonce);
    }
  });

  it.each(live.map((f) => f.name))("%s: refused once the registry stops naming that Settler, and on a table whose previous pin has moved past it", async (name) => {
    const f = loadRecorded(name);
    vi.setSystemTime(f.request.nowMs);
    const run = async (o: {registry?: {current?: string | null; prev?: string | null}; chains?: ReturnType<typeof chainsConfigOf>}) => {
      vi.stubGlobal("fetch", recordedFetch(f, o.registry ? {registry: o.registry} : {}));
      const heard: [string, string | undefined][] = [];
      const q = await zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: o.chains ?? chainsConfigOf(f)}).getQuote(paramsOf(f, {onRefusal: (t, info) => heard.push([t, info?.reason])}));
      return {q, heard};
    };
    // the registry no longer names a previous Settler: the quoted one is no 0x Settler the app resolved
    const dropped = await run({registry: {prev: null}});
    expect(dropped.q).toBeNull();
    expect(dropped.heard).toEqual([[`zeroex: the transaction target ${f.response.transaction.to} is not a 0x Settler from the on-chain registry`, "vault_mismatch"]]);
    // the pins raised past it (previous = newest): the registry's own answer no longer passes the resolver
    const id = chainIdOf(f);
    const c = chainOf(f);
    const raised = await run({chains: {...chainsConfigOf(f), [id]: {...c, previousLiveNonce: c.newestLiveNonce}}});
    expect(raised.q).toBeNull();
    expect(raised.heard).toHaveLength(1);
    expect(raised.heard[0]![1]).toBe("vault_mismatch");
    // and with the recorded registry and the era's table it passes (the replay above), the value going to that Settler
    const ok = await run({});
    expect(ok.heard).toEqual([]);
    expect(ok.q!.txRequest!.to!.toLowerCase()).toBe(f.registry.prev!.toLowerCase());
  });

  it("Monad 1,000,000 MON → AUSD: 0x asked for 6,140,730 gas, a padded 7,388,876 — inside Monad's 15,000,000 cap, refused under the 6,000,000 every other chain keeps", async () => {
    const f = loadRecorded("monad-mon-ausd-1m.2026-11-25");
    expect(f.response.transaction.gas).toBe("6140730");
    const {quote, refusals} = await quoted(f);
    expect(refusals).toEqual([]);
    expect(quote!.txRequest!.gasLimit).toBe("7388876");
    expect(zeroExVerifyQuote(paramsOf(f), quote!, ctxOf(f))).toBeNull();
    // a Monad entry of the integrator's own without `maxGasLimit`: the default cap, and this real answer is refused
    const {maxGasLimit: _drop, ...plain} = ZEROEX_CHAINS[143]!;
    vi.stubGlobal("fetch", recordedFetch(f));
    const heard: [string, string | undefined][] = [];
    const capped = await zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: {...chainsConfigOf(f), 143: plain}}).getQuote(paramsOf(f, {onRefusal: (t, info) => heard.push([t, info?.reason])}));
    expect(capped).toBeNull();
    expect(heard).toEqual([["zeroex: the transaction asks for more gas than any 0x swap needs (its gas limit must be 1 to 6000000 on chain 143)", "policy_refused"]]);
    expect(zeroExVerifyQuote(paramsOf(f), quote!, {...ctxOf(f), chains: {...chainsOf(f), 143: Object.freeze(plain)}})).toBe("the transaction asks for more gas than any 0x swap needs (its gas limit must be 1 to 6000000 on chain 143)");
  });

  it("Monad 62,000 MON → AUSD: 0x asked for 3,970,462 gas, a padded 4,784,554 — under either cap; its /price agrees within the slippage", async () => {
    const f = loadRecorded("monad-mon-ausd-62k.2026-11-25");
    const price = loadRecorded("monad-mon-ausd-62k-price.2026-11-25");
    expect(f.response.transaction.gas).toBe("3970462");
    const {quote, refusals} = await quoted(f);
    expect(refusals).toEqual([]);
    expect(quote!.txRequest!.gasLimit).toBe("4784554");
    expect(BigInt(price.response.buyAmount)).toBeGreaterThan(BigInt(f.response.minBuyAmount));
  });
});
