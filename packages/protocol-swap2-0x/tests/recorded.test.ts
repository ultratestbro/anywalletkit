/**
 * Real 0x answers through every check the device runs (fixtures/quotes: recorded 2026-11-15 on the first seven chains, pin
 * era 2026-11-15, and 2026-11-26 on all eight, pin era 2026-11-25 — where 0x quoted the registry's previous Settler on every chain):
 * the provider's parser, the Settler check, the Permit2 rebuild against 0x's own hash, the engine's quote validation,
 * the remote-mode verifiers, build and preflight, and a full swap through the engine. A future change in 0x's answer
 * shape, or a check that is too strict for what 0x really sends, fails here instead of in production. Each recording is
 * replayed with the chain table of the pin era it was recorded in (tests/recorded.ts, fixtures/pin-eras.json).
 */
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
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
import {SETTLER_NATIVE_CHECK_SELECTOR, SETTLER_PERMIT_ACTIONS, ZEROEX_MAX_GAS_LIMIT, checkZeroExTransaction, createSettlerResolver, decodeSettlerExecute, zeroExSettlerNonce} from "../src/settler.js";
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
  it("no era and no chain may be listed as unrecorded, the era in force included: every pin raise lands with keyed recordings", () => {
    // Both lists are held empty: every era, and every chain of the table, has its recordings (above). An era is
    // recordable only while 0x still quotes its Settlers and the registry still names its pins, so a pin raise (a new
    // era) or a new chain lands together with its real 0x answers, which need ZEROEX_API_KEY. There is no exemption,
    // not even for the era in force (until 44019b07 the era in force could be listed and recorded later).
    expect(UNRECORDED_PIN_ERAS).toEqual([]);
    expect(UNRECORDED_CHAINS).toEqual([]);
  });
  it("fixtures/pin-eras.json says what these tests hold: no era or chain may be listed as unrecorded, a pin raise needs keyed recordings", () => {
    const {note} = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/pin-eras.json", import.meta.url)), "utf8")) as {note: string};
    expect(note).toMatch(/No era and no chain may be listed in unrecorded or unrecordedChains, not even the era in force/);
    expect(note).toMatch(/every pin raise needs keyed recordings/);
    expect(note).not.toMatch(/only the era in force could be|only one that first appears in the era in force could be/);
  });
  // Review 2026-11-26 (C3): the category guards above pass with any one recording of a kind, so losing the verify:live
  // corridor (100 MON → AUSD) or one of two Monad /price answers went unnoticed. Each era's set is pinned by name.
  it("are exactly the recorded set of each era, by name", () => {
    const byEra = (era: string) => RECORDED.filter((name) => loadRecorded(name).pinEra === era).sort();
    expect(byEra("2026-11-15")).toEqual([
      "arbitrum-eth-usdc", "arbitrum-usdc-eth", "arbitrum-usdc-eth-price", "avalanche-avax-usdc", "avalanche-usdc-avax", "avalanche-usdc-avax-price", "avalanche-usdc-joe-huge",
      "base-dai-usdc", "base-eth-usdc", "base-eth-usdc-price", "base-usdc-eth", "base-usdc-eth-badsource", "base-usdc-eth-price", "base-usdc-eth-recipient",
      "bsc-bnb-usdt", "bsc-usdt-babydoge-tax", "bsc-usdt-bnb", "bsc-usdt-bnb-price", "bsc-usdt-usdc-sim",
      "ethereum-eth-usdc", "ethereum-usdc-eth-price", "ethereum-usdc-usdt", "optimism-eth-usdc", "optimism-usdc-eth-price", "optimism-usdc-op",
      "polygon-pol-usdc", "polygon-usdc-pol", "polygon-usdc-pol-price",
    ].sort());
    expect(byEra("2026-11-25")).toEqual([
      "arbitrum-eth-usdc", "arbitrum-usdc-eth", "arbitrum-usdc-eth-price", "avalanche-avax-usdc", "avalanche-usdc-avax", "avalanche-usdc-avax-price",
      "base-eth-usdc", "base-usdc-eth", "base-usdc-eth-price", "bsc-bnb-usdt", "bsc-usdt-bnb", "bsc-usdt-bnb-price",
      "ethereum-eth-usdc", "ethereum-usdc-eth-price", "ethereum-usdc-usdt",
      "monad-mon-ausd", "monad-mon-ausd-1m", "monad-mon-ausd-62k", "monad-mon-ausd-62k-price", "monad-usdc-mon", "monad-usdc-mon-price",
      "optimism-eth-usdc", "optimism-usdc-eth-price", "optimism-usdc-op", "polygon-pol-usdc", "polygon-usdc-pol", "polygon-usdc-pol-price",
    ].map((n) => `${n}.2026-11-25`).sort());
    expect(RECORDED).toHaveLength(28 + 27);
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
    expect(live.length).toBe(18);
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

  // Review 2026-11-26 (C3): the two Monad corridors verify:live quotes (scripts/verify-live.mjs) are replayed by name,
  // so losing either recording fails here and not only the count above.
  it.each([
    ["monad-mon-ausd.2026-11-25", `["Monad MON → AUSD (native)", 143, NATIVE, 18, "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", "100000000000000000000"]`, "453247", "563896"],
    ["monad-usdc-mon.2026-11-25", `["Monad USDC → MON (Permit2)", 143, "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", 6, NATIVE, "25000000"]`, "435460", "542552"],
  ])("%s, a verify:live corridor: the same request, quoted to prev(2), under either cap", async (name, corridor, gas, padded) => {
    const script = readFileSync(fileURLToPath(new URL("../scripts/verify-live.mjs", import.meta.url)), "utf8");
    expect(script).toContain(corridor);
    const f = loadRecorded(name);
    const [, , source, decimals, dest, amount] = JSON.parse(corridor.replace(/NATIVE/g, `"0x${"0".repeat(40)}"`)) as [string, number, string, number, string, string];
    expect({sourceChain: f.request.sourceChain, sourceToken: f.request.sourceToken, destToken: f.request.destToken, amountIn: f.request.amountIn, slippageBps: f.request.slippageBps, dry: f.request.dry}).toEqual({sourceChain: "eip155:143", sourceToken: source, destToken: dest, amountIn: amount, slippageBps: 50, dry: false});
    expect(f.request.sourceDecimals).toBe(nativeSale(f) ? undefined : decimals);
    expect(f.response.transaction.gas).toBe(gas);
    const {quote, refusals} = await quoted(f);
    expect(refusals).toEqual([]);
    expect(quote!.txRequest!.to!.toLowerCase()).toBe(f.registry.prev!.toLowerCase());
    expect(quote!.txRequest!.gasLimit).toBe(padded);
    expect(BigInt(padded)).toBeLessThan(ZEROEX_MAX_GAS_LIMIT);
  });

  // Review 2026-11-26 (C4): the README's Monad gas paragraph cites these recordings. Monad's gas grows with the size of
  // the sale (0x splits a large one across many pools), not by one fixed multiple of Base's: about 1.6 times Base's for
  // the same $1–25 swap, millions only on large MON sales.
  it("Monad's gas, as the README cites it: about 1.6 times Base's on small swaps, growing with the sale (3.97 million at 62,000 MON, 6.14 million at 1,000,000)", () => {
    const gasOf = (name: string) => Number(loadRecorded(name).response.transaction.gas);
    const fills = (name: string) => (loadRecorded(name).response.route.fills as unknown[]).length;
    const small = gasOf("monad-usdc-mon.2026-11-25") / gasOf("base-usdc-eth.2026-11-25"); // 25 USDC → the native coin, on each
    expect([gasOf("monad-usdc-mon.2026-11-25"), gasOf("base-usdc-eth.2026-11-25"), gasOf("monad-mon-ausd.2026-11-25"), gasOf("base-eth-usdc.2026-11-25")]).toEqual([435_460, 269_610, 453_247, 274_827]);
    expect(small).toBeGreaterThan(1.5);
    expect(small).toBeLessThan(1.7);
    expect(gasOf("monad-mon-ausd.2026-11-25") / gasOf("base-eth-usdc.2026-11-25")).toBeLessThan(1.7);
    expect([gasOf("monad-mon-ausd-62k.2026-11-25"), gasOf("monad-mon-ausd-1m.2026-11-25")]).toEqual([3_970_462, 6_140_730]);
    expect([fills("monad-mon-ausd.2026-11-25"), fills("monad-mon-ausd-62k.2026-11-25"), fills("monad-mon-ausd-1m.2026-11-25")]).toEqual([2, 10, 11]);
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    for (const figure of ["435,460", "269,610", "3,970,462", "6,140,730"]) expect(readme, figure).toContain(figure);
    expect(readme).not.toMatch(/7–10 times|1\.48 million/);
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
