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
import {JUPITER_API_DEFAULT, JUPITER_PROGRAM, JUPITER_TX_PROGRAMS, COMPUTE_BUDGET_PROGRAM, SOLANA_CAIP2, WSOL_MINT, jupiter as cfg, jupiterMint} from "./config.js";
import {decodeComputeBudget, decodeSwapArgs, fromBase64, minOutOf} from "./codec.js";
import {assembleTransaction, type JupiterInstruction} from "./transaction.js";
import {timeoutSignal} from "@forgewallet/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@forgewallet/protocol-swap2-core/types";

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

export function jupiterProvider(config: JupiterProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const base = (config.apiUrl ?? JUPITER_API_DEFAULT).replace(/\/$/, "");
  const maxPrice = config.maxComputeUnitPrice ?? DEFAULT_MAX_CU_PRICE;
  const rpcUrls = config.rpcUrls ?? [];

  /** One GET with a single back-off on 429 (keyless traffic is 0.5 RPS), waiting for `x-ratelimit-reset` when given. */
  const get = async (path: string, signal?: AbortSignal): Promise<{ok: boolean; status: number; body: unknown}> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${path}`, {headers: {accept: "application/json", ...(config.apiKey ? {"x-api-key": config.apiKey} : {})}, signal: signal ?? timeoutSignal(12_000)});
      const body = await res.json().catch(() => null);
      if (res.status === 429 && attempt === 0 && !signal?.aborted) {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const wait = Number.isFinite(reset) && reset > 0 ? Math.min(3_000, Math.max(250, reset * 1000 - Date.now())) : 1_200;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return {ok: res.ok, status: res.status, body};
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

  /** Every instruction the API returned, checked; returns the ordered list to assemble and the suggested unit price. */
  const vet = (b: BuildResponse, want: {taker: string; inputMint: string; outputMint: string; amountIn: bigint; slippageBps: number}): {instructions: JupiterInstruction[]; price: bigint; quotedOut: bigint} => {
    if (b.swapMode && b.swapMode !== "ExactIn") throw new Error(`swap mode ${b.swapMode}`);
    if (b.inputMint !== want.inputMint || b.outputMint !== want.outputMint) throw new Error("the answer names other mints");
    if (b.inAmount !== want.amountIn.toString()) throw new Error(`the answer spends ${b.inAmount}, not ${want.amountIn}`);
    if (String(b.transactionVersion ?? "0") !== "0") throw new Error(`transaction version ${b.transactionVersion}`);
    if (b.tipInstruction) throw new Error("unexpected tip instruction");
    if (!b.swapInstruction) throw new Error("no swap instruction");
    if (b.swapInstruction.programId !== JUPITER_PROGRAM) throw new Error(`swap instruction targets ${b.swapInstruction.programId}`);
    const args = decodeSwapArgs(fromBase64(b.swapInstruction.data));
    if (args.inAmount !== want.amountIn) throw new Error(`swap instruction spends ${args.inAmount}, not ${want.amountIn}`);
    if (String(args.quotedOutAmount) !== b.outAmount) throw new Error("swap instruction's quoted output differs from the answer");
    if (args.slippageBps !== want.slippageBps) throw new Error(`swap instruction allows ${args.slippageBps} bps slippage, not ${want.slippageBps}`);
    if (args.platformFeeBps !== 0 || args.positiveSlippageBps !== 0) throw new Error("swap instruction takes a platform fee");
    let price = 0n;
    for (const ix of b.computeBudgetInstructions ?? []) {
      if (ix.programId !== COMPUTE_BUDGET_PROGRAM) throw new Error(`compute-budget slot holds ${ix.programId}`);
      const d = decodeComputeBudget(fromBase64(ix.data));
      if (d.price !== undefined) price = d.price;
    }
    const instructions = [...(b.setupInstructions ?? []), b.swapInstruction, ...(b.cleanupInstruction ? [b.cleanupInstruction] : []), ...(b.otherInstructions ?? [])];
    for (const ix of instructions) {
      if (!JUPITER_TX_PROGRAMS.has(ix.programId) || ix.programId === COMPUTE_BUDGET_PROGRAM) throw new Error(`instruction for program ${ix.programId}`);
      for (const a of ix.accounts) if (a.isSigner && a.pubkey !== want.taker) throw new Error(`instruction needs signer ${a.pubkey}`);
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
        throw new Error(`not enough of the input token in the wallet${jupiterCode === "6025" ? " (no token account for it)" : ""} — simulation fails: ${err}`);
      }
      throw new Error(`simulation fails: ${err}${log ? ` (${log.slice(0, 160)})` : ""}`);
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
      const refuse = (reason: string): null => {
        params.onRefusal?.(`jupiter: ${reason}`);
        return null;
      };
      if (!cfg.supports(params.sourceChain, params.destChain)) return refuse(`same-chain Solana only (${params.sourceChain} → ${params.destChain})`);
      if (params.flex) return refuse("amount-flexible deposits are not supported");
      const inputMint = jupiterMint(params.sourceToken), outputMint = jupiterMint(params.destToken);
      if (!inputMint || !outputMint) return refuse(`unknown token (${params.sourceToken} → ${params.destToken})`);
      if (inputMint === outputMint) return refuse("same token on both sides");
      const amountIn = BigInt(params.amountIn);
      if (amountIn <= 0n) return refuse("amount must be positive");
      const slippageBps = params.slippageBps ?? config.defaultSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) return refuse(`slippage ${slippageBps} bps is out of range`);

      // The swap pays the taker's own token account: a live quote must be for the signer's own address.
      const self = params.refundAddress || params.destAddress;
      if (!dry) {
        if (!self || !BASE58.test(self)) return refuse("live quote without the signer's address");
        if (params.destAddress && params.destAddress !== self) return refuse("the recipient must be the signing wallet (Jupiter pays the taker)");
      }
      const taker = self && BASE58.test(self) ? self : DRY_TAKER;

      const qs = new URLSearchParams({inputMint, outputMint, amount: params.amountIn, taker, slippageBps: String(slippageBps)});
      if (config.computeUnitPricePercentile) qs.set("computeUnitPricePercentile", config.computeUnitPricePercentile);
      let b: BuildResponse;
      try {
        const r = await get(`/build?${qs.toString()}`, signal);
        if (!r.ok) return refuse(`build ${r.status}: ${String((r.body as BuildResponse | null)?.error ?? "").slice(0, 160)}`);
        b = (r.body ?? {}) as BuildResponse;
      } catch (e) { return refuse(`build failed: ${(e as Error).message.slice(0, 160)}`); }
      if (!b.outAmount || !/^\d+$/.test(b.outAmount)) return refuse("answer without an output amount");

      let vetted: ReturnType<typeof vet>;
      try { vetted = vet(b, {taker, inputMint, outputMint, amountIn, slippageBps}); } catch (e) { return refuse((e as Error).message); }
      const minOut = minOutOf(vetted.quotedOut, slippageBps);
      if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) {
        return refuse(`guaranteed ${minOut} is below the floor ${params.minAmountOut} at ${slippageBps} bps`);
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
      if (!blockhash || blockhash.length !== 32 || !lastValid) return refuse("answer without a blockhash");
      const assemble = (limit: number) => assembleTransaction({
        taker, instructions: vetted.instructions, computeUnitLimit: limit, computeUnitPrice: vetted.price,
        blockhash: Uint8Array.from(blockhash), lastValidBlockHeight: lastValid, addressesByLookupTableAddress: b.addressesByLookupTableAddress,
      });
      let wire: string, limit = MAX_COMPUTE_UNITS;
      try {
        wire = assemble(MAX_COMPUTE_UNITS);
        const units = await simulateUnits(wire);
        if (units) { limit = units; wire = assemble(units); }
      } catch (e) { return refuse((e as Error).message.slice(0, 240)); }
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
      if (!tx || quote.intentId.startsWith("dry:")) throw new Error("jupiter: not a live quote");
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
