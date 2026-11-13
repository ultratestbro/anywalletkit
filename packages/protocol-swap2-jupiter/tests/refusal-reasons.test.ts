// CS-13: refusal reasons. Every Jupiter refusal keeps its text; `reason` classifies it. The real provider runs against
// a mocked /build (the answers recorded 2026-10-23, edited) and a mocked Solana RPC — no network, no keys.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {address, getAddressEncoder} from "@solana/kit";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {decodeSwapArgs, fromBase64, toBase64} from "../src/codec.js";
import {jupiterProvider} from "../src/provider.js";

type Ix = {programId: string; accounts: {pubkey: string; isSigner: boolean; isWritable: boolean}[]; data: string};
type Build = Record<string, unknown> & {setupInstructions: Ix[]; cleanupInstruction?: Ix; otherInstructions?: Ix[]; swapInstruction: Ix; outAmount: string};
const file = JSON.parse(readFileSync(new URL("../fixtures/build-2026-10-23.json", import.meta.url), "utf8")) as {taker: string; responses: Record<string, {request: Record<string, string | number>; response: Record<string, unknown>}>};
const T = file.taker;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATTACKER = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SYSTEM = "11111111111111111111111111111111", TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const rec = (k: string) => structuredClone(file.responses[k]!.response) as Build;
const SOL_USDC: QuoteParams = {sourceChain: "solana:mainnet", sourceToken: "SOL", destChain: "solana:mainnet", destToken: USDC, amountIn: "100000000", slippageBps: 50, destAddress: T, refundAddress: T, dry: false};
const USDC_SOL: QuoteParams = {...SOL_USDC, sourceToken: USDC, destToken: "SOL", amountIn: rec("usdc_sol").inAmount as string, slippageBps: Number(file.responses["usdc_sol"]!.request.slippageBps)};
const WSOL_ATA = rec("sol_usdc").setupInstructions.find((ix) => ix.programId === SYSTEM)!.accounts[1]!.pubkey;
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const transfer = (to: string, lamports: bigint): Ix => ({programId: SYSTEM, accounts: [{pubkey: T, isSigner: true, isWritable: true}, {pubkey: to, isSigner: false, isWritable: true}], data: toBase64(Uint8Array.from([2, 0, 0, 0, ...u64(lamports)]))});
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

/** /build answering `answer` (one Response per call, or a recorded build), the RPC answering `rpc`; every /build URL kept. */
function api(answer: Build | Record<string, unknown> | (() => Response | Promise<Response>), rpc?: (body: {method: string}) => unknown) {
  const builds: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!/^https?:\/\//.test(url)) throw new TypeError(`Failed to parse URL from ${url}`);
    if (init?.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    if (url.includes("/build?")) {
      builds.push(url);
      return typeof answer === "function" ? answer() : json(answer);
    }
    if (rpc && init?.body) return json({jsonrpc: "2.0", id: 1, result: rpc(JSON.parse(String(init.body)) as {method: string})});
    return json({}, {status: 404});
  }));
  return builds;
}
afterEach(() => vi.unstubAllGlobals());

/** One getQuote through the real provider: the quote, and the single refusal it heard (text + classification). */
async function quote(params: QuoteParams = SOL_USDC, provider = jupiterProvider(), signal?: AbortSignal) {
  const heard: {text: string; info: Swap2RefusalInfo | undefined; args: number}[] = [];
  const q = await provider.getQuote({...params, onRefusal: (...args: [string, Swap2RefusalInfo?]) => { heard.push({text: args[0], info: args[1], args: args.length}); }}, signal);
  expect(heard.length).toBeLessThanOrEqual(1);
  return {q, text: heard[0]?.text, info: heard[0]?.info, args: heard[0]?.args};
}

describe("jupiter getQuote: the request", () => {
  it("unsupported_pair: another chain, a flexible amount, an unknown or the same token, a recipient other than the taker", async () => {
    api(rec("sol_usdc"));
    const cases: Array<[QuoteParams, string]> = [
      [{...SOL_USDC, destChain: "eip155:1"}, "jupiter: same-chain Solana only (solana:mainnet → eip155:1)"],
      [{...SOL_USDC, flex: true}, "jupiter: amount-flexible deposits are not supported"],
      [{...SOL_USDC, sourceToken: "NOPE"}, "jupiter: unknown token (NOPE → EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)"],
      [{...SOL_USDC, destToken: "SOL"}, "jupiter: same token on both sides"],
      [{...SOL_USDC, destAddress: ATTACKER}, "jupiter: the recipient must be the signing wallet (Jupiter pays the taker)"],
    ];
    for (const [params, text] of cases) {
      const r = await quote(params);
      expect(r.q, text).toBeNull();
      expect(r.text).toBe(text);
      expect(r.info, text).toEqual({reason: "unsupported_pair"});
    }
  });

  it("amount_too_small: a zero amount", async () => {
    api(rec("sol_usdc"));
    const r = await quote({...SOL_USDC, amountIn: "0"});
    expect(r.text).toBe("jupiter: amount must be positive");
    expect(r.info).toEqual({reason: "amount_too_small"});
  });

  it("policy_refused: the caller's slippage above the cap, a live quote without the signer's address", async () => {
    api(rec("sol_usdc"));
    const wide = await quote({...SOL_USDC, slippageBps: 1500});
    expect(wide.text).toBe("jupiter: slippage 1500 bps is out of range");
    expect(wide.info).toEqual({reason: "policy_refused"});
    const noSigner = await quote({...SOL_USDC, destAddress: "", refundAddress: ""});
    expect(noSigner.text).toBe("jupiter: live quote without the signer's address");
    expect(noSigner.info).toEqual({reason: "policy_refused"});
  });

  it("a signer address that is not a Solana address is the caller's argument: the same text, unclassified", async () => {
    const builds = api(rec("sol_usdc"));
    const EVM = "0x1111111111111111111111111111111111111111";
    for (const params of [{...SOL_USDC, destAddress: EVM, refundAddress: ""}, {...SOL_USDC, refundAddress: EVM}]) {
      const r = await quote(params);
      expect(r.q).toBeNull();
      expect(r.text).toBe("jupiter: live quote without the signer's address");
      expect(r.info).toBeUndefined();
      expect(r.args).toBe(1);
    }
    expect(builds).toEqual([]);
  });

  it("a slippage that is not a number of bps, or a default above the cap, is the developer's: unclassified", async () => {
    api(rec("sol_usdc"));
    const negative = await quote({...SOL_USDC, slippageBps: -1});
    expect(negative.text).toBe("jupiter: slippage -1 bps is out of range");
    expect(negative.info).toBeUndefined();
    expect(negative.args).toBe(1);
    const {slippageBps: _s, ...noSlippage} = SOL_USDC;
    const config = await quote(noSlippage, jupiterProvider({defaultSlippageBps: 5000}));
    expect(config.text).toBe("jupiter: slippage 5000 bps is out of range");
    expect(config.info).toBeUndefined();
  });
});

describe("jupiter getQuote: the /build answer", () => {
  it("rate_limited: a 429 after the one back-off, with Retry-After or x-ratelimit-reset", async () => {
    let n = 0;
    const builds = api(() => (n++ === 0 ? json({error: "Rate limit exceeded"}, {status: 429, headers: {"x-ratelimit-reset": "1"}}) : json({error: "Rate limit exceeded"}, {status: 429, headers: {"retry-after": "9"}})));
    const r = await quote();
    expect(r.text).toBe("jupiter: build 429: Rate limit exceeded");
    expect(r.info).toEqual({reason: "rate_limited", retryAfterMs: 9000, httpStatus: 429});
    expect(builds).toHaveLength(2); // the back-off is unchanged
    n = 0;
    const reset = String(Math.floor(Date.now() / 1000) + 20);
    api(() => (n++ === 0 ? json({}, {status: 429, headers: {"x-ratelimit-reset": "1"}}) : json({}, {status: 429, headers: {"x-ratelimit-reset": reset}})));
    const byReset = await quote();
    expect(byReset.text).toBe("jupiter: build 429: ");
    expect(byReset.info).toMatchObject({reason: "rate_limited", httpStatus: 429});
    expect(byReset.info!.retryAfterMs).toBeGreaterThan(17_000);
    expect(byReset.info!.retryAfterMs).toBeLessThanOrEqual(21_000);
  });

  it("rate_limited: an x-ratelimit-reset far ahead (or in milliseconds) is capped at a day, like Retry-After", async () => {
    for (const reset of ["9999999999", String(Date.now() + 60_000)]) {
      let n = 0;
      api(() => (n++ === 0 ? json({}, {status: 429, headers: {"x-ratelimit-reset": "1"}}) : json({}, {status: 429, headers: {"x-ratelimit-reset": reset}})));
      const r = await quote();
      expect(r.text).toBe("jupiter: build 429: ");
      expect(r.info, reset).toEqual({reason: "rate_limited", httpStatus: 429, retryAfterMs: 86_400_000});
    }
  });

  it("key_rejected: 401 / 403; upstream_unavailable: 5xx with the status", async () => {
    api(() => json({error: "Unauthorized"}, {status: 401}));
    const unauthorized = await quote();
    expect(unauthorized.text).toBe("jupiter: build 401: Unauthorized");
    expect(unauthorized.info).toEqual({reason: "key_rejected", httpStatus: 401});
    api(() => json({}, {status: 403}));
    const forbidden = await quote();
    expect(forbidden.text).toBe("jupiter: build 403: ");
    expect(forbidden.info).toEqual({reason: "key_rejected", httpStatus: 403});
    api(() => new Response("<html>unavailable</html>", {status: 503}));
    const down = await quote();
    expect(down.text).toBe("jupiter: build 503: ");
    expect(down.info).toEqual({reason: "upstream_unavailable", httpStatus: 503});
  });

  it("Jupiter's own error wins over the status: no route, an untradable token, too little liquidity, limits", async () => {
    const cases: Array<[number, Record<string, string>, Swap2RefusalInfo["reason"]]> = [
      [400, {error: "No routes found"}, "no_route"],
      [400, {error: "Could not find any route", errorCode: "COULD_NOT_FIND_ANY_ROUTE"}, "no_route"],
      [400, {error: `The token ${ATTACKER} is not tradable`, errorCode: "TOKEN_NOT_TRADABLE"}, "unsupported_pair"],
      [400, {error: "Route plan does not consume all the amount, please lower your amount", errorCode: "ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT"}, "insufficient_liquidity"],
      [400, {error: "Amount is too small"}, "amount_too_small"],
      [400, {error: "Amount is too large"}, "amount_too_large"],
      [500, {error: "insufficient liquidity"}, "insufficient_liquidity"],
    ];
    for (const [status, body, reason] of cases) {
      api(() => json(body, {status}));
      const r = await quote();
      expect(r.text, body.error).toBe(`jupiter: build ${status}: ${body.error}`);
      expect(r.info, body.error).toEqual({reason});
    }
    api(() => json({error: "Invalid taker"}, {status: 400}));
    const unknown = await quote();
    expect(unknown.text).toBe("jupiter: build 400: Invalid taker");
    expect(unknown.info).toBeUndefined();
  });

  it("upstream_unavailable: a network failure, malformed JSON, an answer without amounts or a blockhash; no_route: a 200 that says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const net = await quote();
    expect(net.text).toBe("jupiter: build failed: fetch failed");
    expect(net.info).toEqual({reason: "upstream_unavailable"});
    api(() => new Response("not json"));
    const garbled = await quote();
    expect(garbled.text).toBe("jupiter: answer without an output amount");
    expect(garbled.info).toEqual({reason: "upstream_unavailable"});
    api({error: "No routes found"});
    const none = await quote();
    expect(none.text).toBe("jupiter: answer without an output amount");
    expect(none.info).toEqual({reason: "no_route"});
    const r = rec("sol_usdc");
    delete r.blockhashWithMetadata;
    api(r);
    const noHash = await quote();
    expect(noHash.text).toBe("jupiter: answer without a blockhash");
    expect(noHash.info).toEqual({reason: "upstream_unavailable"});
  });

  it("the caller's own abort, or an apiUrl that is not a URL, is not upstream_unavailable", async () => {
    api(rec("sol_usdc"));
    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = await quote(SOL_USDC, jupiterProvider(), ctrl.signal);
    expect(aborted.text).toBe("jupiter: build failed: This operation was aborted");
    expect(aborted.info).toBeUndefined();
    expect(aborted.args).toBe(1);
    const misconfigured = await quote(SOL_USDC, jupiterProvider({apiUrl: "not a url"}));
    expect(misconfigured.text).toMatch(/^jupiter: build failed: Failed to parse URL from not a url\/build\?/);
    expect(misconfigured.info).toBeUndefined();
  });

  it("the caller's abort while the body is read (it reads as null) is not upstream_unavailable", async () => {
    // Headers arrived, the signal was not aborted at fetch; the caller aborts while the body is read.
    const ctrl = new AbortController();
    api(() => ({
      ok: true, status: 200, headers: new Headers(),
      json: async () => { ctrl.abort(); throw new DOMException("This operation was aborted", "AbortError"); },
    }) as unknown as Response);
    const r = await quote(SOL_USDC, jupiterProvider(), ctrl.signal);
    expect(r.q).toBeNull();
    expect(r.text).toBe("jupiter: answer without an output amount");
    expect(r.info).toBeUndefined();
    expect(r.args).toBe(1);
  });
});

describe("jupiter getQuote: what /build returned", () => {
  const swapData = (k: string, at: number, bytes: number[]) => {
    const r = rec(k);
    const d = fromBase64(r.swapInstruction.data);
    d.set(bytes, at);
    r.swapInstruction.data = toBase64(d);
    return r;
  };
  const edited = (k: string, edit: (r: Build) => void) => { const r = rec(k); edit(r); return r; };
  const quotedOut = BigInt(rec("sol_usdc").outAmount);
  const changedIn = decodeSwapArgs(fromBase64(swapData("sol_usdc", 8, [0x01]).swapInstruction.data)).inAmount;
  const signer = rec("sol_usdc").swapInstruction.accounts[1]!.pubkey;
  const cases: Array<[string, Build, string, Swap2RefusalInfo["reason"], QuoteParams?]> = [
    ["another swap mode", edited("sol_usdc", (r) => { r.swapMode = "ExactOut"; }), "jupiter: swap mode ExactOut", "policy_refused"],
    ["other mints", edited("sol_usdc", (r) => { r.outputMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; }), "jupiter: the answer names other mints", "policy_refused"],
    ["another input in the answer", edited("sol_usdc", (r) => { r.inAmount = "1"; }), "jupiter: the answer spends 1, not 100000000", "policy_refused"],
    ["a v1 transaction", edited("sol_usdc", (r) => { r.transactionVersion = 1; }), "jupiter: transaction version 1", "policy_refused"],
    ["a tip", edited("sol_usdc", (r) => { r.tipInstruction = {programId: SYSTEM, accounts: [], data: ""}; }), "jupiter: unexpected tip instruction", "policy_refused"],
    ["no swap instruction", edited("sol_usdc", (r) => { delete (r as Partial<Build>).swapInstruction; }), "jupiter: no swap instruction", "upstream_unavailable"],
    ["a swap instruction the decoder does not know", edited("sol_usdc", (r) => { r.swapInstruction.data = toBase64(new Uint8Array(40)); }), "jupiter: unsupported Jupiter instruction 0000000000000000", "upstream_unavailable"],
    ["the swap aimed at another program", edited("sol_usdc", (r) => { r.swapInstruction.programId = SYSTEM; }), `jupiter: swap instruction targets ${SYSTEM}`, "vault_mismatch"],
    ["another input inside the swap instruction", swapData("sol_usdc", 8, [0x01]), `jupiter: swap instruction spends ${changedIn}, not 100000000`, "policy_refused"],
    ["a quoted output that differs", edited("sol_usdc", (r) => { r.outAmount = String(quotedOut + 1n); }), "jupiter: swap instruction's quoted output differs from the answer", "price_check_failed"],
    ["a wider slippage inside the swap instruction", swapData("sol_usdc", 24, [0xe8, 0x03]), "jupiter: swap instruction allows 1000 bps slippage, not 50", "price_check_failed"],
    ["a platform fee", swapData("sol_usdc", 26, [0x32]), "jupiter: swap instruction takes a platform fee", "policy_refused"],
    ["a compute-budget slot for another program", edited("sol_usdc", (r) => { r.computeBudgetInstructions = [{programId: SYSTEM, accounts: [], data: ""}]; }), `jupiter: compute-budget slot holds ${SYSTEM}`, "policy_refused"],
    ["a foreign program", edited("sol_usdc", (r) => { r.otherInstructions = [{programId: MEMO, accounts: [], data: ""}]; }), `jupiter: instruction for program ${MEMO}`, "policy_refused"],
    ["an extra signer", edited("sol_usdc", (r) => { r.swapInstruction.accounts[1] = {...r.swapInstruction.accounts[1]!, isSigner: true}; }), `jupiter: instruction needs signer ${signer}`, "policy_refused"],
    ["an ATA instruction other than CreateIdempotent", edited("sol_usdc", (r) => { r.setupInstructions.find((i) => i.programId === ATA)!.data = toBase64(Uint8Array.from([0])); }), "jupiter: an associated-token instruction other than CreateIdempotent", "policy_refused"],
    ["an ATA for someone else", edited("sol_usdc", (r) => { r.setupInstructions[0]!.accounts[2]!.pubkey = ATTACKER; }), "jupiter: an associated token account for someone else", "recipient_mismatch"],
    ["SOL to a third party", edited("sol_usdc", (r) => { r.otherInstructions = [transfer(ATTACKER, 18_000_000n)]; }), `jupiter: a SOL transfer to ${ATTACKER}, not the taker's wSOL account`, "recipient_mismatch"],
    ["funding another amount", edited("sol_usdc", (r) => { r.setupInstructions.find((i) => i.programId === SYSTEM)!.data = transfer(WSOL_ATA, 100_000_001n).data; }), "jupiter: a SOL transfer of 100000001, not the 100000000 input", "policy_refused"],
    ["funding twice", edited("sol_usdc", (r) => { r.otherInstructions = [transfer(WSOL_ATA, 100_000_000n)]; }), "jupiter: a second SOL transfer", "policy_refused"],
    ["a System Assign", edited("sol_usdc", (r) => { r.otherInstructions = [{programId: SYSTEM, accounts: [{pubkey: T, isSigner: true, isWritable: true}], data: toBase64(Uint8Array.from([1, 0, 0, 0, ...new Uint8Array(32)]))}]; }), "jupiter: a System instruction other than Transfer", "policy_refused"],
    ["SOL on a token-source swap", edited("usdc_sol", (r) => { r.otherInstructions = [transfer(WSOL_ATA, 1n)]; }), "jupiter: a SOL transfer on a token-source swap", "policy_refused", USDC_SOL],
    ["SyncNative elsewhere", edited("sol_usdc", (r) => { r.setupInstructions.find((i) => i.programId === TOKEN)!.accounts[0]!.pubkey = ATTACKER; }), "jupiter: SyncNative on another account", "policy_refused"],
    ["closing to someone else", edited("sol_usdc", (r) => { r.cleanupInstruction!.accounts[1]!.pubkey = ATTACKER; }), "jupiter: a CloseAccount that is not the taker's wSOL account back to the taker", "recipient_mismatch"],
    ["a token account for someone else", edited("sol_usdc", (r) => { r.otherInstructions = [{programId: TOKEN, accounts: [{pubkey: WSOL_ATA, isSigner: false, isWritable: true}], data: toBase64(Uint8Array.from([18, ...getAddressEncoder().encode(address(ATTACKER))]))}]; }), "jupiter: a token account initialized for someone else", "recipient_mismatch"],
    ["a Token transfer", edited("sol_usdc", (r) => { r.otherInstructions = [{programId: TOKEN, accounts: [], data: toBase64(Uint8Array.from([12, ...u64(500_000n), 6]))}]; }), "jupiter: a Token instruction (tag 12) the swap does not need", "policy_refused"],
    ["a second Jupiter call", edited("sol_usdc", (r) => { r.otherInstructions = [structuredClone(r.swapInstruction)]; }), "jupiter: a second Jupiter instruction", "policy_refused"],
  ];
  it.each(cases)("%s", async (_what, build, text, reason, params) => {
    api(build);
    const r = await quote(params ?? SOL_USDC);
    expect(r.q).toBeNull();
    expect(r.text).toBe(text);
    expect(r.info).toEqual({reason});
  });

  it("price_check_failed: a floor above what the instruction guarantees", async () => {
    api(rec("sol_usdc"));
    const r = await quote({...SOL_USDC, minAmountOut: "999999999"});
    expect(r.text).toBe(`jupiter: guaranteed ${(quotedOut * 9_950n) / 10_000n} is below the floor 999999999 at 50 bps`);
    expect(r.info).toEqual({reason: "price_check_failed"});
  });

  it("simulation_failed: the wallet lacking the input, or any other failing simulation", async () => {
    const cases: Array<[unknown, string, string]> = [
      [{InstructionError: [3, {Custom: 6025}]}, "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1789", `jupiter: not enough of the input token in the wallet (no token account for it) — simulation fails: {"InstructionError":[3,{"Custom":6025}]}`],
      [{InstructionError: [3, {Custom: 1}]}, "Program log: Error: insufficient funds", `jupiter: simulation fails: {"InstructionError":[3,{"Custom":1}]} (Program log: Error: insufficient funds)`],
    ];
    for (const [err, log, text] of cases) {
      api(rec("sol_usdc"), () => ({value: {err, logs: [log]}}));
      const r = await quote(SOL_USDC, jupiterProvider({rpcUrls: ["https://rpc.example"]}));
      expect(r.text).toBe(text);
      expect(r.info).toEqual({reason: "simulation_failed"});
    }
  });

  it("upstream_unavailable: lookup tables the transaction cannot be assembled with", async () => {
    let expected = "";
    try { address("bad"); } catch (e) { expected = (e as Error).message; }
    api(edited("sol_usdc", (r) => { r.addressesByLookupTableAddress = {bad: []}; }));
    const r = await quote();
    expect(r.text).toBe(`jupiter: ${expected.slice(0, 240)}`);
    expect(r.info).toEqual({reason: "upstream_unavailable"});
  });
});

describe("jupiter buildDeposit", () => {
  it("policy_refused: a dry quote or one without a transaction; a plain Error with the same text", async () => {
    api(rec("sol_usdc"));
    const dry = (await jupiterProvider().getQuote({...SOL_USDC, dry: true}))!;
    for (const q of [dry, {...dry, intentId: "jup:1"} as Quote]) {
      const err = await jupiterProvider().buildDeposit(q).then(() => undefined, (e: unknown) => e as Error);
      expect(err?.constructor).toBe(Error);
      expect(err?.message).toBe("jupiter: not a live quote");
      expect(refusalOf(err)).toEqual({reason: "policy_refused"});
    }
  });
});
