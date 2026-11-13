/**
 * Jupiter provider — Swap API V2 Router path, same-chain Solana swaps:
 *   quote + instructions   GET /swap/v2/build?inputMint&outputMint&amount&taker&slippageBps
 *   status                 getSignatureStatuses on the caller's own Solana RPC (optional)
 * Routing is Metis (Jupiter's on-chain router); the Router path charges no Jupiter swap fee. Keyless access works at
 * 0.5 RPS; pass `apiKey` (sent as `x-api-key`) for a plan's rate limit.
 *
 * Nothing from the API is trusted as-is. Before a live quote is handed out, every instruction is checked: only the
 * Jupiter program and the token / system / ATA / compute-budget plumbing, the taker is the only signer, no tip, and
 * the swap instruction's own arguments (decoded) carry exactly our input amount, the quoted output, our slippage and
 * a zero platform fee — those are what the program enforces on-chain. The compute budget is rebuilt here: a unit price
 * capped by `maxComputeUnitPrice`, and a unit limit from a simulation (1.2× the units used) when `rpcUrls` is given.
 * The account then executes the assembled transaction through its serialized-transaction guard (simulation +
 * balance proof against the quote) and broadcasts it through its own RPC.
 */
import {describeJupiterActivity} from "./activity.js";
import {ATA_PROGRAM, JUPITER_API_DEFAULT, JUPITER_PROGRAM, JUPITER_TX_PROGRAMS, COMPUTE_BUDGET_PROGRAM, SOLANA_CAIP2, SYSTEM_PROGRAM, TOKEN_PROGRAM, WSOL_MINT, jupiter as cfg, jupiterMint} from "./config.js";
import {address, getAddressEncoder, getProgramDerivedAddress} from "@solana/kit";
import {decodeComputeBudget, decodeSwapArgs, fromBase64, minOutOf} from "./codec.js";
import {assembleTransaction, type JupiterInstruction} from "./transaction.js";
import {httpRefusal, refusal, refusalNotes, refusalOf, withReason, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";

const DEFAULT_SLIPPAGE_BPS = 50;
const MAX_SLIPPAGE_BPS = 1_000;
/** A /build blockhash lives ~60–90 s; the quote must be signed well inside it. */
const QUOTE_TTL_MS = 30_000;
const MAX_COMPUTE_UNITS = 1_400_000;
/** 2 000 000 µlamports/CU: at 1.4 M CU the priority fee is ≤ 0.0028 SOL. */
const DEFAULT_MAX_CU_PRICE = 2_000_000n;
const BASE_FEE_LAMPORTS = 5_000n;
/** Taker for a dry quote with no address yet: /build needs one, the price does not depend on it. */
const DRY_TAKER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Longest `retryAfterMs` passed on: a day, core's own ceiling. */
const RETRY_AFTER_MAX_MS = 86_400_000;

export interface JupiterProviderConfig {
  enabled?: boolean;
  /** Swap API base (default https://api.jup.ag/swap/v2). */
  apiUrl?: string;
  /** Jupiter Developer Platform key, sent as `x-api-key`. Keyless works at 0.5 RPS. */
  apiKey?: string;
  /** Solana JSON-RPC endpoints: compute-unit simulation and status. Without them the limit is 1.4 M CU and status stays pending. */
  rpcUrls?: readonly string[];
  /** Ceiling on the compute-unit price Jupiter suggests, micro-lamports (default 2 000 000). */
  maxComputeUnitPrice?: bigint;
  /** Passed to /build: "medium" | "high" | "veryHigh" or a percentile in bps (default: Jupiter's 50th percentile). */
  computeUnitPricePercentile?: string;
  /** Slippage when the caller names none, bps (default 50). */
  defaultSlippageBps?: number;
}

interface BuildResponse {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  routePlan?: {bps?: number; swapInfo?: {label?: string}}[];
  computeBudgetInstructions?: JupiterInstruction[];
  setupInstructions?: JupiterInstruction[];
  swapInstruction?: JupiterInstruction;
  cleanupInstruction?: JupiterInstruction | null;
  otherInstructions?: JupiterInstruction[];
  tipInstruction?: JupiterInstruction | null;
  addressesByLookupTableAddress?: Record<string, string[]> | null;
  transactionVersion?: number | string;
  blockhashWithMetadata?: {blockhash?: number[]; lastValidBlockHeight?: number};
  error?: string;
}

const INTENT_PREFIX = "jup:";

/** The reason behind each text `shapeRefusal` returns. */
const notes = refusalNotes();

/**
 * What a failed /build answer means: Jupiter's own error first (no route, an untradable token, too little liquidity,
 * limits), else the status (429 with Retry-After or `x-ratelimit-reset`, 401 / 403, 408 / 425 / 5xx). Undefined when
 * neither says.
 */
function buildRefusal(status: number, body: unknown, retryAfter: string | null, rateReset: string | null): Swap2RefusalInfo | undefined {
  const byStatus = httpRefusal(status, retryAfter);
  if (byStatus?.reason === "rate_limited") {
    if (byStatus.retryAfterMs !== undefined || rateReset === null) return byStatus;
    const wait = Number(rateReset) * 1000 - Date.now();
    // Capped at a day like core's Retry-After: a reset far ahead (or given in milliseconds) is no wait of centuries.
    return Number.isFinite(wait) && wait > 0 ? {...byStatus, retryAfterMs: Math.min(Math.ceil(wait), RETRY_AFTER_MAX_MS)} : byStatus;
  }
  const said = answerReason(body);
  return said && said !== byStatus?.reason ? {reason: said} : byStatus;
}
function answerReason(body: unknown): Swap2RefusalReason | undefined {
  const b = body as {error?: unknown; errorCode?: unknown} | null;
  const text = `${typeof b?.errorCode === "string" ? b.errorCode : ""} ${typeof b?.error === "string" ? b.error : ""}`;
  if (/COULD_NOT_FIND_ANY_ROUTE|NO_ROUTES_FOUND|could not find any route|no routes? found/i.test(text)) return "no_route";
  if (/ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT|liquidity/i.test(text)) return "insufficient_liquidity";
  if (/TOKEN_NOT_TRADABLE|not tradable|MARKET_NOT_FOUND|CIRCULAR_ARBITRAGE|not supported|unsupported/i.test(text)) return "unsupported_pair";
  if (/too small|too low|below the minimum/i.test(text)) return "amount_too_small";
  if (/too large|too big|above the maximum/i.test(text)) return "amount_too_large";
  if (/rate.?limit|too many requests/i.test(text)) return "rate_limited";
  if (/api.?key|unauthori[sz]ed/i.test(text)) return "key_rejected";
  return undefined;
}

export function jupiterProvider(config: JupiterProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const base = (config.apiUrl ?? JUPITER_API_DEFAULT).replace(/\/$/, "");
  const maxPrice = config.maxComputeUnitPrice ?? DEFAULT_MAX_CU_PRICE;
  const rpcUrls = config.rpcUrls ?? [];
  // An apiUrl that is neither an http(s) URL nor a same-origin path is a configuration error: its fetch failures are no refusal.
  const baseIsUrl = /^(?:https?:\/\/[^/\s]+|\/)/i.test(base);

  /** One GET with a single back-off on 429 (keyless traffic is 0.5 RPS), waiting for `x-ratelimit-reset` when given. */
  const get = async (path: string, signal?: AbortSignal): Promise<{ok: boolean; status: number; body: unknown; retryAfter: string | null; rateReset: string | null}> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${path}`, {headers: {accept: "application/json", ...(config.apiKey ? {"x-api-key": config.apiKey} : {})}, signal: signal ?? timeoutSignal(12_000)});
      const body = await res.json().catch(() => null);
      if (res.status === 429 && attempt === 0 && !signal?.aborted) {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const wait = Number.isFinite(reset) && reset > 0 ? Math.min(3_000, Math.max(250, reset * 1000 - Date.now())) : 1_200;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return {ok: res.ok, status: res.status, body, retryAfter: res.headers?.get?.("retry-after") ?? null, rateReset: res.headers?.get?.("x-ratelimit-reset") ?? null};
    }
  };

  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    let last: unknown = new Error("no Solana RPC configured");
    for (const url of rpcUrls) {
      try {
        const res = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal: timeoutSignal(10_000)});
        const body = (await res.json()) as {result?: unknown; error?: {message?: string}};
        if (body.error) throw new Error(body.error.message ?? "rpc error");
        return body.result;
      } catch (e) { last = e; }
    }
    throw last;
  };

  /**
   * The setup / cleanup / other instructions /build may carry, by exact shape (scan 2026-10-27 modules, F32/F33):
   * creating the taker's own ATAs, funding the taker's wSOL account with exactly the input (a SOL source), syncing and
   * closing it back to the taker. Anything else — a System transfer elsewhere, a token transfer, a second Jupiter call —
   * is refused; the wallet's balance proof alone let a few hundredths of a SOL and the slippage band leave per swap.
   */
  const shapeRefusal = (ix: JupiterInstruction, want: {taker: string; inputMint: string; amountIn: bigint; wsolAta: string}): string | null => {
    const data = fromBase64(ix.data ?? "");
    const acc = (i: number) => ix.accounts[i]?.pubkey;
    if (ix.programId === ATA_PROGRAM) {
      // CreateIdempotent: [payer, ata, owner, mint, system, token program] — the taker pays for its own account.
      if (data.length !== 1 || data[0] !== 1) return notes.note("an associated-token instruction other than CreateIdempotent", "policy_refused");
      if (acc(0) !== want.taker || acc(2) !== want.taker) return notes.note("an associated token account for someone else", "recipient_mismatch");
      return null;
    }
    if (ix.programId === SYSTEM_PROGRAM) {
      // Transfer: u32 LE 2 + u64 lamports, [from, to] — only the input, into the taker's own wSOL account.
      if (data.length !== 12 || data[0] !== 2 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0) return notes.note("a System instruction other than Transfer", "policy_refused");
      if (want.inputMint !== WSOL_MINT) return notes.note("a SOL transfer on a token-source swap", "policy_refused");
      const lamports = new DataView(data.buffer, data.byteOffset + 4, 8).getBigUint64(0, true);
      if (acc(0) !== want.taker || acc(1) !== want.wsolAta) return notes.note(`a SOL transfer to ${acc(1)}, not the taker's wSOL account`, "recipient_mismatch");
      if (lamports !== want.amountIn) return notes.note(`a SOL transfer of ${lamports}, not the ${want.amountIn} input`, "policy_refused");
      return null;
    }
    if (ix.programId === TOKEN_PROGRAM) {
      if (data.length === 1 && data[0] === 17) return acc(0) === want.wsolAta ? null : notes.note("SyncNative on another account", "policy_refused"); // SyncNative
      if (data.length === 1 && data[0] === 9) { // CloseAccount: [account, destination, owner]
        return acc(0) === want.wsolAta && acc(1) === want.taker && acc(2) === want.taker ? null : notes.note("a CloseAccount that is not the taker's wSOL account back to the taker", "recipient_mismatch");
      }
      if (data.length === 33 && data[0] === 18) { // InitializeAccount3(owner): an account the taker owns
        return bytesEqual(data.subarray(1), getAddressEncoder().encode(address(want.taker))) ? null : notes.note("a token account initialized for someone else", "recipient_mismatch");
      }
      return notes.note(`a Token instruction (tag ${data[0] ?? "none"}) the swap does not need`, "policy_refused");
    }
    if (ix.programId === JUPITER_PROGRAM) return notes.note("a second Jupiter instruction", "policy_refused");
    return notes.note(`instruction for program ${ix.programId}`, "policy_refused");
  };

  /** Every instruction the API returned, checked; returns the ordered list to assemble and the suggested unit price. */
  const vet = (b: BuildResponse, want: {taker: string; inputMint: string; outputMint: string; amountIn: bigint; slippageBps: number; wsolAta: string}): {instructions: JupiterInstruction[]; price: bigint; quotedOut: bigint} => {
    if (b.swapMode && b.swapMode !== "ExactIn") throw refusal("policy_refused", `swap mode ${b.swapMode}`);
    if (b.inputMint !== want.inputMint || b.outputMint !== want.outputMint) throw refusal("policy_refused", "the answer names other mints");
    if (b.inAmount !== want.amountIn.toString()) throw refusal("policy_refused", `the answer spends ${b.inAmount}, not ${want.amountIn}`);
    if (String(b.transactionVersion ?? "0") !== "0") throw refusal("policy_refused", `transaction version ${b.transactionVersion}`);
    if (b.tipInstruction) throw refusal("policy_refused", "unexpected tip instruction");
    if (!b.swapInstruction) throw refusal("upstream_unavailable", "no swap instruction");
    if (b.swapInstruction.programId !== JUPITER_PROGRAM) throw refusal("vault_mismatch", `swap instruction targets ${b.swapInstruction.programId}`);
    const args = decodeSwapArgs(fromBase64(b.swapInstruction.data));
    if (args.inAmount !== want.amountIn) throw refusal("policy_refused", `swap instruction spends ${args.inAmount}, not ${want.amountIn}`);
    if (String(args.quotedOutAmount) !== b.outAmount) throw refusal("price_check_failed", "swap instruction's quoted output differs from the answer");
    if (args.slippageBps !== want.slippageBps) throw refusal("price_check_failed", `swap instruction allows ${args.slippageBps} bps slippage, not ${want.slippageBps}`);
    if (args.platformFeeBps !== 0 || args.positiveSlippageBps !== 0) throw refusal("policy_refused", "swap instruction takes a platform fee");
    let price = 0n;
    for (const ix of b.computeBudgetInstructions ?? []) {
      if (ix.programId !== COMPUTE_BUDGET_PROGRAM) throw refusal("policy_refused", `compute-budget slot holds ${ix.programId}`);
      const d = decodeComputeBudget(fromBase64(ix.data));
      if (d.price !== undefined) price = d.price;
    }
    const instructions = [...(b.setupInstructions ?? []), b.swapInstruction, ...(b.cleanupInstruction ? [b.cleanupInstruction] : []), ...(b.otherInstructions ?? [])];
    let funded = false;
    for (const ix of instructions) {
      if (!JUPITER_TX_PROGRAMS.has(ix.programId) || ix.programId === COMPUTE_BUDGET_PROGRAM) throw refusal("policy_refused", `instruction for program ${ix.programId}`);
      for (const a of ix.accounts) if (a.isSigner && a.pubkey !== want.taker) throw refusal("policy_refused", `instruction needs signer ${a.pubkey}`);
      if (ix === b.swapInstruction) continue;
      const why = shapeRefusal(ix, want);
      if (why) {
        const info = notes.reasonOf(why);
        throw info ? withReason(new Error(why), info) : new Error(why);
      }
      if (ix.programId === SYSTEM_PROGRAM) {
        if (funded) throw refusal("policy_refused", "a second SOL transfer");
        funded = true;
      }
    }
    return {instructions, price: price > maxPrice ? maxPrice : price, quotedOut: args.quotedOutAmount};
  };

  /** 1.2× the units a simulation uses (capped); null when no RPC answers. A failing simulation refuses the quote. */
  const simulateUnits = async (wire: string): Promise<number | null> => {
    if (!rpcUrls.length) return null;
    let r: {value?: {err?: unknown; unitsConsumed?: number; logs?: string[]}};
    try {
      r = (await rpc("simulateTransaction", [wire, {encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed"}])) as typeof r;
    } catch {
      return null;
    }
    if (r?.value?.err) {
      const log = (r.value.logs ?? []).filter((l) => /error|failed|insufficient/i.test(l)).slice(-1)[0] ?? "";
      const err = JSON.stringify(r.value.err);
      // The usual reason, said plainly: the wallet lacks the input. Confirmed 2026-10-24 by building the same
      // USDS / LINK / WBTC → USDC swaps from an empty wallet (6025) and from real holders (built fine).
      // Jupiter 6024 = insufficient funds, 6025 = no token account for the input; System Program 1 = not enough SOL.
      const jupiterCode = /JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed/.test(log) ? /"Custom":(\d+)/.exec(err)?.[1] : undefined;
      if (jupiterCode === "6024" || jupiterCode === "6025" || (/"Custom":1\}/.test(err) && /Program 11111111111111111111111111111111 failed/.test(log))) {
        throw refusal("simulation_failed", `not enough of the input token in the wallet${jupiterCode === "6025" ? " (no token account for it)" : ""} — simulation fails: ${err}`);
      }
      throw refusal("simulation_failed", `simulation fails: ${err}${log ? ` (${log.slice(0, 160)})` : ""}`);
    }
    const used = r?.value?.unitsConsumed;
    return used ? Math.min(MAX_COMPUTE_UNITS, Math.ceil(used * 1.2)) : null;
  };

  return {
    name: "jupiter",
    describeActivity: describeJupiterActivity,
    enabled: () => config.enabled ?? true,
    supportsSameChain: true,
    supportsChain: (chain: string) => cfg.supportsChain(chain),
    supportsChainPair: (from: string, to: string) => cfg.supports(from, to),
    supportsRoute(from: Asset, to: Asset): boolean {
      if (!cfg.supports(from.chain, to.chain)) return false;
      const a = jupiterMint(from.token), b = jupiterMint(to.token);
      return !!a && !!b && a !== b;
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const dry = params.dry !== false;
      const refuse = (reason: string, why?: Swap2RefusalReason | Swap2RefusalInfo): null => {
        const info = typeof why === "string" ? {reason: why} : why;
        if (info) params.onRefusal?.(`jupiter: ${reason}`, info);
        else params.onRefusal?.(`jupiter: ${reason}`);
        return null;
      };
      if (!cfg.supports(params.sourceChain, params.destChain)) return refuse(`same-chain Solana only (${params.sourceChain} → ${params.destChain})`, "unsupported_pair");
      if (params.flex) return refuse("amount-flexible deposits are not supported", "unsupported_pair");
      const inputMint = jupiterMint(params.sourceToken), outputMint = jupiterMint(params.destToken);
      if (!inputMint || !outputMint) return refuse(`unknown token (${params.sourceToken} → ${params.destToken})`, "unsupported_pair");
      if (inputMint === outputMint) return refuse("same token on both sides", "unsupported_pair");
      const amountIn = BigInt(params.amountIn);
      if (amountIn <= 0n) return refuse("amount must be positive", "amount_too_small");
      const slippageBps = params.slippageBps ?? config.defaultSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) return refuse(`slippage ${slippageBps} bps is out of range`, params.slippageBps !== undefined && Number.isInteger(slippageBps) && slippageBps > MAX_SLIPPAGE_BPS ? "policy_refused" : undefined);

      // The swap pays the taker's own token account: a live quote must be for the signer's own address.
      const self = params.refundAddress || params.destAddress;
      if (!dry) {
        // No address at all is the policy; one that is not a Solana address is the caller's argument (unclassified).
        if (!self || !BASE58.test(self)) return refuse("live quote without the signer's address", !self ? "policy_refused" : undefined);
        if (params.destAddress && params.destAddress !== self) return refuse("the recipient must be the signing wallet (Jupiter pays the taker)", "unsupported_pair");
      }
      const taker = self && BASE58.test(self) ? self : DRY_TAKER;

      const qs = new URLSearchParams({inputMint, outputMint, amount: params.amountIn, taker, slippageBps: String(slippageBps)});
      if (config.computeUnitPricePercentile) qs.set("computeUnitPricePercentile", config.computeUnitPricePercentile);
      let b: BuildResponse;
      // A network failure or our own timeout is Jupiter's; the caller's abort is not.
      try {
        const r = await get(`/build?${qs.toString()}`, signal);
        if (!r.ok) return refuse(`build ${r.status}: ${String((r.body as BuildResponse | null)?.error ?? "").slice(0, 160)}`, buildRefusal(r.status, r.body, r.retryAfter, r.rateReset));
        b = (r.body ?? {}) as BuildResponse;
      } catch (e) { return refuse(`build failed: ${(e as Error).message.slice(0, 160)}`, signal?.aborted || !baseIsUrl ? undefined : "upstream_unavailable"); }
      // A body the caller's abort cut short reads as null: that is no answer of another shape.
      if (!b.outAmount || !/^\d+$/.test(b.outAmount)) return refuse("answer without an output amount", answerReason(b) ?? (signal?.aborted ? undefined : "upstream_unavailable"));

      let vetted: ReturnType<typeof vet>;
      const [wsolAta] = await getProgramDerivedAddress({programAddress: address(ATA_PROGRAM), seeds: [getAddressEncoder().encode(address(taker)), getAddressEncoder().encode(address(TOKEN_PROGRAM)), getAddressEncoder().encode(address(WSOL_MINT))]});
      // A check that fails names its reason; an answer the decoders cannot read is one of another shape.
      try { vetted = vet(b, {taker, inputMint, outputMint, amountIn, slippageBps, wsolAta}); } catch (e) { return refuse((e as Error).message, refusalOf(e) ?? "upstream_unavailable"); }
      const minOut = minOutOf(vetted.quotedOut, slippageBps);
      if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) {
        return refuse(`guaranteed ${minOut} is below the floor ${params.minAmountOut} at ${slippageBps} bps`, "price_check_failed");
      }
      const route = (b.routePlan ?? []).map((s) => s.swapInfo?.label).filter(Boolean).join(" + ");
      const impact = Number(b.priceImpactPct ?? 0);
      const common = {
        provider: "jupiter",
        depositAddress: "",
        depositMemo: null,
        sourceAmount: params.amountIn,
        destAmount: b.outAmount,
        minDestAmount: minOut.toString(),
        feeUsd: 0,
        etaSeconds: 15,
        reliability: impact > 0.05 ? 0.8 : 0.97,
        validUntilMs: Date.now() + QUOTE_TTL_MS,
      };
      if (dry) {
        return {...common, intentId: `dry:${INTENT_PREFIX}${Date.now().toString(36)}`, fees: [{type: "network" as const, amount: BASE_FEE_LAMPORTS.toString(), token: "native", included: false, description: "Solana base fee"}], ...(route ? {providerData: {route}} : {})};
      }

      const blockhash = b.blockhashWithMetadata?.blockhash;
      const lastValid = b.blockhashWithMetadata?.lastValidBlockHeight;
      if (!blockhash || blockhash.length !== 32 || !lastValid) return refuse("answer without a blockhash", "upstream_unavailable");
      const assemble = (limit: number) => assembleTransaction({
        taker, instructions: vetted.instructions, computeUnitLimit: limit, computeUnitPrice: vetted.price,
        blockhash: Uint8Array.from(blockhash), lastValidBlockHeight: lastValid, addressesByLookupTableAddress: b.addressesByLookupTableAddress,
      });
      let wire: string, limit = MAX_COMPUTE_UNITS;
      // The simulation's verdict, else a transaction the answer's instructions or lookup tables cannot assemble.
      try {
        wire = assemble(MAX_COMPUTE_UNITS);
        const units = await simulateUnits(wire);
        if (units) { limit = units; wire = assemble(units); }
      } catch (e) { return refuse((e as Error).message.slice(0, 240), refusalOf(e) ?? "upstream_unavailable"); }
      const priority = (vetted.price * BigInt(limit) + 999_999n) / 1_000_000n;
      return {
        ...common,
        intentId: `${INTENT_PREFIX}${lastValid}:${Date.now().toString(36)}`,
        // `value` declares the native SOL the transaction may take: the input for a SOL source (Jupiter wraps it), none for a token.
        txRequest: {serializedTx: wire, value: inputMint === WSOL_MINT ? params.amountIn : "0"},
        fees: [{type: "network", amount: (BASE_FEE_LAMPORTS + priority).toString(), token: "native", included: false, description: `Solana base + priority fee (${limit} CU at ${vetted.price} µlamports)`}],
        providerData: {inputMint, outputMint, slippageBps: String(slippageBps), computeUnits: String(limit), ...(route ? {route} : {})},
      };
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest?.serializedTx;
      if (!tx || quote.intentId.startsWith("dry:")) throw refusal("policy_refused", "jupiter: not a live quote");
      return {chain: SOLANA_CAIP2, to: "", value: quote.txRequest!.value ?? "0", serializedTx: tx};
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash || !rpcUrls.length) return {state: "pending"};
      try {
        const r = (await rpc("getSignatureStatuses", [[ref.sourceTxHash], {searchTransactionHistory: true}])) as {value?: ({err?: unknown; confirmationStatus?: string} | null)[]};
        const s = r?.value?.[0];
        if (!s) return {state: "pending"};
        if (s.err) return {state: "failed"};
        return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? {state: "completed", destTxHash: ref.sourceTxHash} : {state: "pending"};
      } catch {
        return {state: "pending"};
      }
    },
  };
}

function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
