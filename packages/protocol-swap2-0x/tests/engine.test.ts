/**
 * The whole path a wallet runs: quote → checks → exact Permit2 allowance → EIP-712 signature → signed call.
 * Local mode (the integrator's key on this machine), remote mode (the key on a backend, checks on the device),
 * and the router's snapshot of the provider.
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import {hashTypedData, recoverTypedDataAddress} from "viem";
import {privateKeyToAccount, generatePrivateKey} from "viem/accounts";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import {ZEROEX_PERMIT2} from "../src/chains.js";
import {zeroExProvider} from "../src/provider.js";
import {ZeroExSwap2Protocol} from "../src/protocol.js";
import {zeroExPins, zeroExRemoteProvider, zeroExVerifyBuild, zeroExVerifyQuote} from "../src/remote.js";
import {decodeSettlerExecute} from "../src/settler.js";
import {AMOUNT, KEY, OLDER_SETTLER, OTHER, PREV_SETTLER, RPC, SETTLER, USDC, ZERO, getKey, stub, type ApiStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

// A throwaway signer made for this run: the signature below is a real EIP-712 one, checked by recovery.
const signer = privateKeyToAccount(generatePrivateKey());
const ME = signer.address;
const MIN = 398_000_000_000_000n; // 50 bps under the stubbed 400000000000000
const options = {fromToken: "USDC", toToken: ZERO, toChain: 8453, recipient: ME, fromTokenAmount: AMOUNT, minAmountOut: MIN};
const APPROVE = (amount: bigint) => `0x095ea7b3${ZEROEX_PERMIT2.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;

interface Sent {to?: string; data?: string; value?: bigint; gasLimit?: bigint}
interface Log {sent: Sent[]; signed: Record<string, any>[]; estimated: Sent[]; rawHashSigns: number}
const fresh = (): Log => ({sent: [], signed: [], estimated: [], rawHashSigns: 0});
function account(log: Log, over: Record<string, unknown> = {}) {
  return {
    getAddress: async () => ME,
    getChainId: async () => 8453,
    getBalance: async () => 10n ** 18n,
    getAllowance: async () => 0n,
    quoteSendTransaction: async (t: Sent) => { log.estimated.push(t); return {fee: 1n}; },
    sendTransaction: async (t: Sent) => { log.sent.push(t); return {hash: `0x${String(log.sent.length).padStart(64, "0")}`}; },
    waitForTransaction: async () => {},
    signTypedData: async (args: Record<string, any>) => { log.signed.push(args); return signer.signTypedData(args as never); },
    // No raw-hash signing is ever asked for; if the engine tried, this would record it.
    sign: async () => { log.rawHashSigns++; throw new Error("raw hash signing is not available"); },
    signMessage: async () => { log.rawHashSigns++; throw new Error("message signing is not part of a swap"); },
    ...over,
  };
}
type Calls = NonNullable<ApiStub["calls"]>;
function world(o: ApiStub = {}) {
  const calls: Calls = [];
  vi.stubGlobal("fetch", stub({...o, calls}));
  return calls;
}
const local = (acc: unknown, review?: (p: Swap2ExecutionPlan) => unknown) =>
  new ZeroExSwap2Protocol(acc as never, {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: RPC, ...(review ? {reviewExecution: review as never} : {})});

describe("ZeroExSwap2Protocol — local mode", () => {
  it("token sale: exact approve to Permit2, one EIP-712 signature bound to the Settler, signature appended, signed call sent", async () => {
    world();
    const log = fresh();
    let plan: Swap2ExecutionPlan | undefined;
    const result = await local(account(log), (p) => { plan = p; }).swap2(options);

    expect(plan!.approvals).toHaveLength(1);
    expect(plan!.approvals[0]).toMatchObject({spender: ZEROEX_PERMIT2, amount: AMOUNT, chainId: 8453});
    expect(plan!.approvals[0]!.token.toLowerCase()).toBe(USDC.toLowerCase());
    expect(plan!.source).toMatchObject({kind: "call", to: SETTLER, value: 0n});

    // typed data only
    expect(log.rawHashSigns).toBe(0);
    expect(log.signed).toHaveLength(1);
    const signed = log.signed[0]!;
    expect(signed.primaryType).toBe("PermitTransferFrom");
    expect(signed.domain).toEqual({name: "Permit2", chainId: 8453, verifyingContract: ZEROEX_PERMIT2});
    expect(signed.message.permitted.token.toLowerCase()).toBe(USDC.toLowerCase());
    expect(signed.message.permitted.amount).toBe(AMOUNT.toString());
    expect(signed.message.spender.toLowerCase()).toBe(SETTLER.toLowerCase());

    expect(log.sent).toHaveLength(2);
    expect(log.sent[0]).toMatchObject({data: APPROVE(AMOUNT)});
    expect(log.sent[0]!.to!.toLowerCase()).toBe(USDC.toLowerCase());
    const swap = log.sent[1]!;
    expect(swap).toMatchObject({to: SETTLER, value: 0n});
    // the gas limit is the account's own estimate of the signed call, never the quoted one
    expect(swap.gasLimit).toBeUndefined();
    // data = the checked call + uint256(65) + the signature
    const unsigned = (plan!.source as {data: string}).data;
    expect(swap.data!.startsWith(unsigned)).toBe(true);
    const tail = swap.data!.slice(unsigned.length);
    expect(tail.slice(0, 64)).toBe(`${"0".repeat(62)}41`);
    const signature = `0x${tail.slice(64)}` as const;
    expect(signature).toHaveLength(2 + 130);
    // the appended signature is this account's signature over exactly the payload that was checked
    expect(await recoverTypedDataAddress({...(signed as never as Parameters<typeof hashTypedData>[0]), signature})).toBe(ME);
    // and the call still pays this account at least the minimum
    expect(decodeSettlerExecute(unsigned)).toMatchObject({recipient: ME, minAmountOut: MIN});
    // the signed call was estimated from the account before it was broadcast
    expect(log.estimated.at(-1)!.data).toBe(swap.data);
    expect(result.hash).toBe(`0x${"2".padStart(64, "0")}`);
  });

  it("the key goes to the API in a header and appears nowhere in what the wallet sees or sends", async () => {
    const calls = world();
    const log = fresh();
    let plan: Swap2ExecutionPlan | undefined;
    await local(account(log), (p) => { plan = p; }).swap2(options);
    const api = calls.filter((c) => c.method === "GET");
    expect(api.length).toBeGreaterThan(0);
    for (const c of api) {
      expect(c.headers["0x-api-key"]).toBe(KEY);
      expect(c.url).not.toContain(KEY);
    }
    for (const c of calls.filter((x) => x.method === "POST")) expect(JSON.stringify(c)).not.toContain(KEY);
    const seen = JSON.stringify([plan, log.signed, log.sent], (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(seen).not.toContain(KEY);
  });

  it("an allowance to Permit2 that already covers the input is left alone", async () => {
    world();
    const log = fresh();
    let plan: Swap2ExecutionPlan | undefined;
    await local(account(log, {getAllowance: async () => AMOUNT}), (p) => { plan = p; }).swap2(options);
    expect(plan!.approvals).toEqual([]);
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.to).toBe(SETTLER);
    expect(log.signed).toHaveLength(1);
  });

  it("native sale: no approval, no signature, value = the amount sold", async () => {
    world({out: 2_500_000n});
    const log = fresh();
    await local(account(log)).swap2({fromToken: "ETH", toToken: USDC, toChain: 8453, recipient: ME, fromTokenAmount: 10n ** 15n, minAmountOut: 2_487_500n});
    expect(log.signed).toHaveLength(0);
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]).toMatchObject({to: SETTLER, value: 10n ** 15n});
    expect(decodeSettlerExecute(log.sent[0]!.data!)).toMatchObject({recipient: ME, buyToken: USDC, minAmountOut: 2_487_500n});
  });

  it("an account that cannot sign typed data sends nothing — the permit is asked for before the approval", async () => {
    world();
    const log = fresh();
    await expect(local(account(log, {signTypedData: undefined})).swap2(options)).rejects.toThrow(/needs an account with signTypedData/);
    expect(log.rawHashSigns).toBe(0);
    expect(log.sent).toEqual([]);
  });

  it("a signed call that does not simulate is quoted once more, then not sent; the Permit2 allowance stays (signature transfer only)", async () => {
    world();
    const log = fresh();
    const acc = account(log, {quoteSendTransaction: async (t: Sent) => { if (log.signed.length && t.to === SETTLER && t.gasLimit === undefined) throw new Error("execution reverted"); return {fee: 1n}; }});
    await expect(local(acc).swap2(options)).rejects.toThrow(/signed swap does not simulate from this account/);
    // the first pass and the re-quote pass each signed a permit; no approve(Permit2, 0)
    expect(log.signed).toHaveLength(2);
    expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT)]);
  });

  it("a Settler that left the registry between quote and execution: no swap sent, nothing signed, the Permit2 allowance stays", async () => {
    // read 1 = the live quote; read 2 = preflight, where the registry no longer names the quoted Settler (paused, rolled back)
    world({onRegistryRead: (n) => (n === 1 ? {current: SETTLER, prev: PREV_SETTLER} : {current: PREV_SETTLER, prev: OLDER_SETTLER})});
    const log = fresh();
    await expect(local(account(log)).swap2(options)).rejects.toThrow(/the quoted 0x Settler is no longer in the on-chain registry/);
    // the engine approves, runs the provider's preflight, and asks for the permit only after it passed: nothing is signed
    expect(log.sent.map((s) => s.data)).toEqual([APPROVE(AMOUNT)]);
    expect(log.signed).toHaveLength(0);
    // only the gas pre-check (the unsigned call at its quoted limit) touched the Settler call: the signed one was not even dry-run
    expect(log.estimated.filter((e) => e.to === SETTLER).every((e) => e.gasLimit !== undefined)).toBe(true);
  });

  const tampered: [string, ApiStub, RegExp][] = [
    ["a Settler outside the registry", {settler: OTHER}, /no route|not a 0x Settler/i],
    ["a permit for an unlimited amount", {tamper: (b) => { if (b.permit2) { b.permit2.eip712.message.permitted.amount = (2n ** 256n - 1n).toString(); b.permit2.hash = null; } return b; }}, /no route|permitted amount/i],
    ["a permit to another spender", {tamper: (b) => { if (b.permit2) { b.permit2.eip712.message.spender = OTHER; b.permit2.hash = null; } return b; }}, /no route|spender/i],
    ["calldata paying someone else", {tamper: (b) => { if (b.transaction) b.transaction.data = `0x1fff991f${OTHER.slice(2).padStart(64, "0")}${(b.transaction.data as string).slice(74)}`; return b; }}, /no route|not the recipient/i],
    ["calldata with a zero minimum", {tamper: (b) => { if (b.transaction) b.transaction.data = `${(b.transaction.data as string).slice(0, 138)}${"0".repeat(64)}${(b.transaction.data as string).slice(202)}`; return b; }}, /no route|minimum/i],
  ];
  for (const [name, o, why] of tampered) {
    it(`an API answer with ${name} never reaches approval or signature`, async () => {
      world(o);
      const log = fresh();
      await expect(local(account(log)).swap2(options)).rejects.toThrow(why);
      expect(log.sent).toEqual([]);
      expect(log.signed).toEqual([]);
    });
  }
});

// ── remote mode ──────────────────────────────────────────────────────────────

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
/** The backend an app runs: the real provider (it holds the key) behind the real swap2 handler. `corrupt` = a compromised one. */
function backend(corrupt?: (q: Quote, params: QuoteParams) => Quote, raw = false): {fetchImpl: typeof fetch; requests: {action: string; body: unknown}[]} {
  const real = zeroExProvider({apiKey: getKey, rpcUrls: RPC});
  const provider: CrossChainProvider = corrupt
    ? {...real, getQuote: async (p, s) => { const q = await real.getQuote(p, s); return q ? corrupt(q, p) : q; }, preflightDeposit: async () => {}}
    : real;
  const handle = createSwap2Handler<string>({providers: [provider], sealSecret: SECRET, guard: () => {}, subject: () => "alice"});
  const requests: {action: string; body: unknown}[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const action = String(url).split("/").pop()!;
    const body = JSON.parse(String(init.body)) as unknown;
    requests.push({action, body});
    // A backend that does not even run the swap2 handler's own sanity checks: the device is the only check left.
    if (raw && action === "quote") return new Response(JSON.stringify(await provider.getQuote((body as {params: QuoteParams}).params)), {status: 200, headers: {"content-type": "application/json"}});
    const res = await handle(action, body, "alice");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
  return {fetchImpl, requests};
}
function remote(acc: unknown, fetchImpl: typeof fetch, review?: (p: Swap2ExecutionPlan) => unknown) {
  const provider = zeroExRemoteProvider({baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, rpcUrls: RPC});
  class P extends SingleProviderSwap2 {
    protected readonly provider = provider;
    protected chainSupported(): boolean { return true; }
  }
  return {provider, swap2: new P(acc as never, {fromChain: "eip155:8453", ...(review ? {reviewExecution: review as never} : {})})};
}

describe("zeroExRemoteProvider — the key on a backend, the checks on the device", () => {
  it("runs the whole swap through the backend; the device never holds or sends the key", async () => {
    world();
    const log = fresh();
    const b = backend();
    const app = remote(account(log), b.fetchImpl);
    expect(app.provider).toMatchObject({name: "zeroex", remote: true, verifiesQuotes: true, verifiesBuilds: true, supportsSameChain: true});
    await app.swap2.swap2(options);
    expect(b.requests.map((r) => r.action)).toContain("quote");
    expect(b.requests.map((r) => r.action)).toContain("build");
    expect(JSON.stringify(b.requests)).not.toContain(KEY);
    expect(log.rawHashSigns).toBe(0);
    expect(log.signed).toHaveLength(1);
    expect(log.signed[0]!.message.spender.toLowerCase()).toBe(SETTLER.toLowerCase());
    expect(log.sent.map((s) => s.to!.toLowerCase())).toEqual([USDC.toLowerCase(), SETTLER.toLowerCase()]);
    expect(log.sent[0]!.data).toBe(APPROVE(AMOUNT));
  });

  it("serves the chain table without a key, and pins Permit2 as the only spender and the registry's Settlers as the only targets", async () => {
    world();
    const pins = zeroExPins({rpcUrls: RPC});
    expect(pins.spenders!("eip155:8453")).toEqual([ZEROEX_PERMIT2]);
    expect(pins.spenders!("eip155:100")).toEqual([]);
    expect(pins.callTargets!("eip155:8453")).toEqual([]);
    await pins.resolver.resolve(8453);
    expect(pins.callTargets!("eip155:8453")).toEqual([SETTLER, PREV_SETTLER]);
    expect(pins.callTargets!("eip155:1")).toEqual([]);
    const p = zeroExRemoteProvider({baseUrl: "https://backend.example/api", rpcUrls: RPC});
    expect(p.supportsChain!("eip155:8453")).toBe(true);
    expect(p.supportsChain!("eip155:100")).toBe(false);
    expect(p.supportsChainPair!("eip155:8453", "eip155:1")).toBe(false);
  });

  const txOf = (q: Quote) => q.txRequest!;
  const attacks: [string, (q: Quote, p: QuoteParams) => Quote, RegExp, boolean?][] = [
    ["its own contract as the target", (q) => (q.txRequest ? {...q, txRequest: {...txOf(q), to: OTHER}} : q), /is not a 0x Settler from the on-chain registry/],
    ["a recipient of its own in the calldata", (q) => (q.txRequest ? {...q, txRequest: {...txOf(q), data: `0x1fff991f${OTHER.slice(2).padStart(64, "0")}${txOf(q).data!.slice(74)}`}} : q), /not the recipient of this swap/],
    ["a lowered minimum in the calldata", (q) => (q.txRequest ? {...q, txRequest: {...txOf(q), data: `${txOf(q).data!.slice(0, 138)}${"1".padStart(64, "0")}${txOf(q).data!.slice(202)}`}} : q), /enforces a minimum of 1, not the quoted/],
    ["a lowered minimum in the quote and the calldata alike", (q) => ({...q, minDestAmount: "1", ...(q.txRequest ? {txRequest: {...txOf(q), data: `${txOf(q).data!.slice(0, 138)}${"1".padStart(64, "0")}${txOf(q).data!.slice(202)}`}} : {})}), /quoted minimum 1 is below/, true],
    ["a permit for more than the input", (q) => (q.txRequest ? {...q, txRequest: {...txOf(q), permit2Transfer: txOf(q).permit2Transfer!.replace(`"amount":"${AMOUNT}"`, `"amount":"${2n ** 255n}"`)}} : q), /permitted amount is not the swap's/],
    ["a permit to its own spender", (q) => (q.txRequest ? {...q, txRequest: {...txOf(q), permit2Transfer: txOf(q).permit2Transfer!.replace(new RegExp(SETTLER, "i"), OTHER)}} : q), /spender is not the contract the swap calls/],
    ["an allowance to its own spender", (q) => (q.txRequest ? {...q, txRequest: {...txOf(q), approvalAddress: OTHER}} : q), /allowance target is not canonical Permit2/],
    ["native coin attached", (q) => (q.txRequest ? {...q, txRequest: {...txOf(q), value: "1000000000000000"}} : q), /sends native coin with a token sale/, true],
    ["a larger spend", (q) => ({...q, sourceAmount: (AMOUNT * 2n).toString()}), /spends 2000000, not the 1000000 input/, true],
  ];
  for (const [name, corrupt, why, raw] of attacks) {
    it(`a backend that answers ${name} is refused before anything is approved or signed`, async () => {
      world();
      const log = fresh();
      const app = remote(account(log), backend(corrupt, raw).fetchImpl);
      await expect(app.swap2.swap2(options)).rejects.toThrow(why);
      expect(log.sent).toEqual([]);
      expect(log.signed).toEqual([]);
    });
  }

  it("an indicative quote that carries a transaction is refused", async () => {
    world();
    const b = backend((q) => ({...q, txRequest: {to: SETTLER, data: "0x1fff991f", value: "0", chainId: 8453}}), true);
    const provider = zeroExRemoteProvider({baseUrl: "https://backend.example/api", fetchImpl: b.fetchImpl, rpcUrls: RPC});
    await expect(provider.getQuote({sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: ZERO, amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME, slippageBps: 50} as never)).rejects.toThrow(/an indicative quote carries a transaction/);
  });

  it("when the backend quotes a Settler newer than the device's read, the device reads the registry again — and only then accepts", async () => {
    // The backend (first reader) and the device share the stubbed chain: read 1 → old pair (device cache), later reads → rotated.
    let reads = 0;
    // The rotation that really happened on Base: {22, 21} → {23, 22}. Once 0x moves its quotes over it quotes 23; on
    // 2026-11-26 it still quoted 22, the previous one.
    const calls = world({onRegistryRead: () => (++reads === 1 ? {current: PREV_SETTLER, prev: OLDER_SETTLER} : {current: SETTLER, prev: PREV_SETTLER})});
    const provider = zeroExRemoteProvider({baseUrl: "https://backend.example/api", fetchImpl: backend().fetchImpl, rpcUrls: RPC});
    const q = await provider.getQuote({sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: ZERO, amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME, slippageBps: 50, dry: false} as never);
    expect(q!.txRequest!.to).toBe(SETTLER);
    expect(calls.length).toBeGreaterThan(4);
    // a Settler no registry read ever named stays refused after the second look
    world({settler: OTHER});
    const again = zeroExRemoteProvider({baseUrl: "https://backend.example/api", fetchImpl: backend((x) => (x.txRequest ? {...x, txRequest: {...x.txRequest, to: OTHER}} : x)).fetchImpl, rpcUrls: RPC});
    await expect(again.getQuote({sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: ZERO, amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME, slippageBps: 50, dry: false} as never)).rejects.toThrow(/is not a 0x Settler from the on-chain registry/);
  });

  it("a live quote needs the device's own RPC: without one nothing is asked of the backend", async () => {
    world();
    const b = backend();
    const provider = zeroExRemoteProvider({baseUrl: "https://backend.example/api", fetchImpl: b.fetchImpl, rpcUrls: {}});
    await expect(provider.getQuote({sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: ZERO, amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME, dry: false} as never)).rejects.toThrow(/no RPC is configured for chain 8453/);
    expect(b.requests).toEqual([]);
  });
});

describe("zeroExVerifyQuote / zeroExVerifyBuild", () => {
  const PARAMS = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: ZERO, amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME, slippageBps: 50} as QuoteParams;
  const ctx = (settlers: readonly string[] = [SETTLER, PREV_SETTLER]) => ({chains: zeroExPins().chains, settlers: () => settlers});
  const liveQuote = async (): Promise<Quote> => {
    world();
    return (await zeroExProvider({apiKey: getKey, rpcUrls: RPC}).getQuote({...PARAMS, dry: false}))!;
  };

  it("passes the provider's own live and indicative quotes, with or without the server's intent tag", async () => {
    const q = await liveQuote();
    expect(zeroExVerifyQuote({...PARAMS, dry: false}, q, ctx())).toBeNull();
    expect(zeroExVerifyQuote({...PARAMS, dry: false}, {...q, intentId: `${q.intentId}~${"ab".repeat(16)}`}, ctx())).toBeNull();
    const {txRequest: _, ...dry} = q;
    expect(zeroExVerifyQuote(PARAMS, dry, ctx())).toBeNull();
  });

  it("names what is wrong with a quote", async () => {
    const q = await liveQuote();
    const live = {...PARAMS, dry: false} as QuoteParams;
    const {txRequest: _, ...bare} = q;
    const cases: [string, QuoteParams, Quote, ReturnType<typeof ctx>, RegExp][] = [
      ["another provider", live, {...q, provider: "lifi"}, ctx(), /not a 0x quote/],
      ["two chains", {...live, destChain: "eip155:1"}, q, ctx(), /stay on one chain/],
      ["a chain outside the table", {...live, sourceChain: "eip155:100", destChain: "eip155:100"}, q, ctx(), /not in the 0x chain table/],
      ["an intent for another chain", live, {...q, intentId: "zeroex:1:abc"}, ctx(), /intent id does not name this chain/],
      ["a minimum under the slippage", live, {...q, minDestAmount: "390000000000000"}, ctx(), /is below 50 bps of the quoted output/],
      ["a minimum under the caller's floor", {...live, minAmountOut: "399000000000000"}, q, ctx(), /below the caller's floor/],
      ["a live quote without a transaction", live, bare, ctx(), /a live quote carries no transaction/],
      ["a serialized transaction riding along", live, {...q, txRequest: {...q.txRequest!, serializedTx: "AA=="}}, ctx(), /more than a Settler call/],
      ["a native fee riding along", live, {...q, txRequest: {...q.txRequest!, nativeFee: "1"}}, ctx(), /more than a Settler call/],
      ["no recipient", {...live, destAddress: "someone"}, q, ctx(), /needs the recipient/],
      ["no Settler resolved on the device", live, q, ctx([]), /the 0x Settler for chain 8453 is not resolved/],
      ["a Settler the device does not know", live, q, ctx([OLDER_SETTLER]), /is not a 0x Settler from the on-chain registry/],
      ["a quote that outlives its Permit2 deadline", live, {...q, validUntilMs: Date.now() + 2 * 3600_000}, ctx(), /outlives its Permit2 deadline/],
      ["another recipient than the app's", {...live, destAddress: OTHER}, q, ctx(), /not the recipient of this swap/],
      ["another buy token than the app asked for", {...live, destToken: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"}, q, ctx(), /not the token asked for/],
    ];
    for (const [name, p, quote, c, why] of cases) expect(zeroExVerifyQuote(p, quote, c), name).toMatch(why);
  });

  it("a build must be the quoted transaction, checked against the registry as it is now", async () => {
    const q = await liveQuote();
    const pins = zeroExPins({rpcUrls: RPC});
    const built = await zeroExProvider({apiKey: getKey, rpcUrls: RPC}).buildDeposit(q);
    const check = (tx = built, params: QuoteParams | null = PARAMS, quote = q) => zeroExVerifyBuild(quote, tx, params ?? undefined, {chains: pins.chains, settlers: () => [], resolver: pins.resolver});
    expect(await check()).toBeNull();
    expect(await pins.verifyBuild!(q, built, PARAMS)).toBeNull();
    expect(await check(built, null)).toMatch(/request this quote answered is not known to the app/);
    expect(await check({...built, to: OTHER})).toMatch(/built transaction is not the quoted swap/);
    expect(await check({...built, data: `${built.data}00`})).toMatch(/built transaction is not the quoted swap/);
    expect(await check({...built, value: "5"})).toMatch(/built transaction is not the quoted swap/);
    expect(await check({...built, gasLimit: "5999999"})).toMatch(/built transaction is not the quoted swap/);
    expect(await check({...built, approvalAddress: OTHER})).toMatch(/built transaction is not the quoted swap/);
    expect(await check({...built, permit2Transfer: `${built.permit2Transfer} `})).toMatch(/built transaction is not the quoted swap/);
    expect(await check({...built, typedData: "{}"})).toMatch(/built transaction is not the quoted swap/);
    const {txRequest: _, ...bare} = q;
    expect(await check(built, PARAMS, bare)).toMatch(/quote carries no transaction/);
    // the registry moved on since the quote (rolled back to the previous Settler), or names a replaced one
    world({registry: {current: PREV_SETTLER, prev: null}});
    expect(await check()).toMatch(/is not a 0x Settler from the on-chain registry/);
    world({registry: {current: OLDER_SETTLER, prev: null}});
    expect(await check()).toMatch(/\(Settler deployment 21\) as the 0x Settler, older than the oldest this module accepts there \(22\)/);
    world({registry: {current: null}});
    expect(await check()).toMatch(/reports no taker Settler in force/);
  });
});

describe("router registration", () => {
  const METHODS = ["enabled", "supportsRoute", "getQuote", "buildDeposit", "trackIntent", "preflightDeposit", "supportsChain", "supportsChainPair", "describeActivity"];

  it("every member of the local provider is one the router's snapshot carries (settlerResolver is the app's own handle)", () => {
    const p = zeroExProvider({apiKey: getKey, rpcUrls: RPC});
    expect(Object.keys(p).sort()).toEqual(["name", "supportsSameChain", "ownGasEstimate", "settlerResolver", ...METHODS].sort());
    const snap = new CrossChainRouter([p]).getProvider("zeroex")! as unknown as Record<string, unknown>;
    for (const m of METHODS) expect(typeof snap[m], m).toBe("function");
    expect(snap.supportsSameChain).toBe(true);
    expect(snap.ownGasEstimate).toBe(true);
    expect(snap.name).toBe("zeroex");
  });

  it("the remote provider keeps its marker, pins and checks through the snapshot", () => {
    const p = zeroExRemoteProvider({baseUrl: "https://backend.example/api", rpcUrls: RPC});
    const snap = new CrossChainRouter([p]).getProvider("zeroex")! as unknown as Record<string, unknown>;
    expect(snap).toMatchObject({remote: true, verifiesQuotes: true, verifiesBuilds: true, supportsSameChain: true, ownGasEstimate: true});
    for (const m of ["callTargets", "spenders", "preflightDeposit", "describeActivity", "supportsChain", "supportsChainPair"]) expect(typeof snap[m], m).toBe("function");
    expect((snap.spenders as (c: string) => string[])("eip155:8453")).toEqual([ZEROEX_PERMIT2]);
  });

  it("the router quotes through it and executes the same checked swap", async () => {
    world();
    const router = new CrossChainRouter([zeroExProvider({apiKey: getKey, rpcUrls: RPC})]);
    expect(router.supportsChainPair("eip155:8453", "eip155:8453")).toBe(true);
    const best = await router.getBestQuote({sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: ZERO, amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME, slippageBps: 50, dry: false} as never);
    expect(best?.provider).toBe("zeroex");
    expect(best?.txRequest).toMatchObject({to: SETTLER, approvalAddress: ZEROEX_PERMIT2});
    expect(best?.fees?.map((f) => f.type)).toEqual(["protocol", "network"]);
  });
});
