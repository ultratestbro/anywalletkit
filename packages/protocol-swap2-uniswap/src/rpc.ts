import {redactUrls, timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import {httpRefusal, refusal, refusalOf, withReason, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";

/**
 * JSON-RPC for the Uniswap provider: batches with endpoint failover, and a per-item answer that tells a revert (the
 * call ran and the contract said no: an answer) from a call the node did not answer (a rate limit, a node error, an
 * item left out). Before 0.4.12 every per-item error read as `null`, so a `-32007 "50/second request limit reached"` on
 * the best pool's quote made that pool silently "not a candidate" and a worse route won (UNISWAP-V4-RESEARCH §2.2, M1).
 */

export type RpcCall = {method: string; params: unknown[]};

/** A JSON-RPC error object as the node sent it; `data` is kept (a revert's bytes: v4 reads its error selectors). */
export interface RpcItemError {
  code?: number;
  message: string;
  data?: unknown;
}

/**
 * One call's outcome: its result; a revert (final — the call ran); or no answer after the retries the policy allows
 * (`failed`, an Error classified `rate_limited` / `upstream_unavailable` / whatever the HTTP status said).
 */
export type RpcSlot =
  | {readonly ok: true; readonly result: unknown}
  | {readonly ok: false; readonly revert: RpcItemError}
  | {readonly ok: false; readonly failed: Error};

/**
 * What is retried:
 * - `none`: nothing; one pass over the endpoints, as 0.4.11 sent it;
 * - `items`: calls the node answered with a JSON-RPC error that is not a revert, left out of its answer, or refused as
 *   a whole batch with a JSON-RPC error; an HTTP or network failure of every endpoint is not retried (0.4.11: failover
 *   only, and its reason — a 429's wait — goes to the caller);
 * - `all`: every call without an answer, HTTP and network failures too.
 */
export type RetryPolicy = "none" | "items" | "all";

/** Largest JSON-RPC batch sent to one node (X Layer's public RPCs refuse more than 10). */
export const RPC_BATCH_MAX = 10;
/**
 * Batches one request keeps in flight at once: 40 calls, under the per-second good-item rate a keyed endpoint was
 * measured to serve (QuickNode on Monad answered 50 calls a second and `-32007` the rest, UNISWAP-V4-RESEARCH §5.3).
 * A v3 quote is at most 40 calls, so it still goes out in one wave.
 */
export const RPC_MAX_IN_FLIGHT = 4;
/** Waits before each retry (ms): long enough for a per-second window to pass. */
const RETRY_DELAYS_MS = [300, 1000] as const;

/** JSON-RPC codes nodes use for "too many requests" (EIP-1474 -32005; QuickNode -32007; OnFinality -32029; others). */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([429, -32005, -32007, -32011, -32029, -32090]);
const RATE_LIMIT_TEXT = /rate.?limit|too many|request limit|limit (?:reached|exceeded)|exceeds? (?:the )?limit|throttl|capacity|quota/i;
const REVERT_TEXT = /revert|out of gas|invalid opcode|invalid jump|stack (?:underflow|overflow)|vm execution error/i;

/**
 * A per-item JSON-RPC error read as a revert (the call ran: an answer) or as the reason the node did not answer. Code 3
 * (geth, reth, Monad) and revert bytes in `data` are reverts; `-32000 "execution reverted"` (Besu, Erigon, an empty
 * revert) by its text. A rate-limit code or text is `rate_limited`; anything else (`header not found`, `missing trie
 * node`, an internal error) is `upstream_unavailable` — never "no pool".
 */
export function rpcErrorKind(error: RpcItemError): "revert" | Extract<Swap2RefusalReason, "rate_limited" | "upstream_unavailable"> {
  if (error.code === 3) return "revert";
  if (typeof error.code === "number" && RATE_LIMIT_CODES.has(error.code)) return "rate_limited";
  if (typeof error.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(error.data)) return "revert";
  if (REVERT_TEXT.test(error.message)) return "revert";
  if (RATE_LIMIT_TEXT.test(error.message)) return "rate_limited";
  return "upstream_unavailable";
}

function itemError(raw: unknown): RpcItemError {
  const e = (raw && typeof raw === "object" ? raw : {}) as {code?: unknown; message?: unknown; data?: unknown};
  return {
    ...(typeof e.code === "number" ? {code: e.code} : {}),
    message: typeof e.message === "string" ? e.message : typeof raw === "string" ? raw : "error",
    ...(e.data !== undefined ? {data: e.data} : {}),
  };
}

/** A node's error as refusal text: code and message, URLs taken out (a keyed endpoint may echo its own), kept short. */
const describe = (e: RpcItemError) => redactUrls(e.code !== undefined ? `${e.code} ${e.message}` : e.message).slice(0, 200);

/**
 * A chunk every endpoint failed: the final error, and whether the last failure was at the JSON-RPC level. Told apart
 * by its brand, not `instanceof` (an Error subclass lowered for Hermes is not guaranteed to keep its prototype).
 */
class ChunkFailure extends Error {
  readonly chunkFailure = true as const;
  constructor(readonly error: Error, readonly jsonRpc: boolean) {
    super(error.message);
  }
}
const isChunkFailure = (e: unknown): e is ChunkFailure => !!e && typeof e === "object" && (e as {chunkFailure?: unknown}).chunkFailure === true;

/** Resolves after `ms`, or as soon as the caller aborts (the next attempt then fails with the abort). */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener?.("abort", done, {once: true});
  });
}

export interface UniswapRpc {
  /** Every call's outcome. Throws only for the caller's abort (unclassified) and, under `none` / `items`, for a chunk
   *  that no endpoint answered over HTTP (classified, as 0.4.11 threw it). */
  slots(chainId: number, calls: readonly RpcCall[], policy: RetryPolicy, signal?: AbortSignal): Promise<RpcSlot[]>;
  /** As 0.4.11's `rpc`: each slot the result, or null for a revert; any call without an answer throws its error. */
  results(chainId: number, calls: readonly RpcCall[], policy: RetryPolicy, signal?: AbortSignal): Promise<(unknown | null)[]>;
}

export function uniswapRpc(rpcUrls: Readonly<Record<number, readonly string[]>>): UniswapRpc {
  /** One chunk over the endpoints (starting at `start`), each slot its answer — or a ChunkFailure when none answered. */
  async function chunk(chainId: number, calls: readonly RpcCall[], start: number, signal?: AbortSignal): Promise<RpcSlot[]> {
    const urls = rpcUrls[chainId] ?? [];
    let lastErr: unknown;
    let jsonRpc = false;
    for (let k = 0; k < urls.length; k++) {
      const url = urls[(start + k) % urls.length]!;
      let batchRefused = false;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify(calls.map((c, id) => ({jsonrpc: "2.0", id, ...c}))),
          signal: signal ?? timeoutSignal(12_000),
        });
        if (!res.ok) {
          const error = new Error(`HTTP ${res.status}`);
          const info = httpRefusal(res.status, res.headers?.get?.("retry-after"));
          throw info ? withReason(error, info) : error;
        }
        const body = (await res.json()) as {id: number; result?: unknown; error?: unknown}[] | {error?: {message?: string}};
        if (!Array.isArray(body)) {
          // The whole batch refused with a JSON-RPC error (a rate limit, a batch-size cap): no call was answered.
          const e = itemError(body.error);
          const kind = rpcErrorKind(e);
          batchRefused = true;
          throw withReason(new Error(body.error?.message !== undefined ? describe({message: String(body.error.message)}) : "batch refused"), kind === "revert" ? "upstream_unavailable" : kind);
        }
        const out: (RpcSlot | undefined)[] = calls.map(() => undefined);
        for (const r of body) {
          if (!r || typeof r !== "object" || typeof r.id !== "number" || !Number.isInteger(r.id) || r.id < 0 || r.id >= out.length) continue;
          if (r.error === undefined) {
            out[r.id] = {ok: true, result: r.result ?? null};
            continue;
          }
          const e = itemError(r.error);
          const kind = rpcErrorKind(e);
          out[r.id] = kind === "revert" ? {ok: false, revert: e} : {ok: false, failed: refusal(kind, `uniswap: no RPC answered on chain ${chainId} (${describe(e)})`)};
        }
        return out.map((s) => s ?? {ok: false, failed: refusal("upstream_unavailable", `uniswap: no RPC answered on chain ${chainId} (the node left a call unanswered)`)});
      } catch (e) {
        lastErr = e;
        jsonRpc = batchRefused;
      }
    }
    const error = new Error(`uniswap: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
    // Every endpoint failed: the last one's own classification (a 429, a rejected key), else unavailable — never the caller's abort.
    if (signal?.aborted) throw error;
    throw new ChunkFailure(withReason(error, refusalOf(lastErr) ?? "upstream_unavailable"), jsonRpc);
  }

  /** The calls in chunks of RPC_BATCH_MAX, at most RPC_MAX_IN_FLIGHT at once, in order. */
  async function pass(chainId: number, calls: readonly RpcCall[], start: number, policy: RetryPolicy, signal?: AbortSignal): Promise<RpcSlot[]> {
    const chunks: RpcCall[][] = [];
    for (let i = 0; i < calls.length; i += RPC_BATCH_MAX) chunks.push(calls.slice(i, i + RPC_BATCH_MAX));
    const out: RpcSlot[][] = new Array(chunks.length);
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        try {
          out[i] = await chunk(chainId, chunks[i]!, start, signal);
        } catch (e) {
          if (!isChunkFailure(e)) throw e; // the caller's abort
          // Under `all` (and `items` for a JSON-RPC-level refusal) the chunk's calls are retried like any unanswered call.
          if (policy === "all" || (policy === "items" && e.jsonRpc)) out[i] = chunks[i]!.map(() => ({ok: false, failed: e.error}));
          else throw e.error;
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(RPC_MAX_IN_FLIGHT, chunks.length)}, worker));
    return out.flat();
  }

  async function slots(chainId: number, calls: readonly RpcCall[], policy: RetryPolicy, signal?: AbortSignal): Promise<RpcSlot[]> {
    const out = await pass(chainId, calls, 0, policy, signal);
    if (policy === "none") return out;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      const missing = out.flatMap((s, i) => ("failed" in s ? [i] : []));
      if (missing.length === 0) break;
      await pause(RETRY_DELAYS_MS[attempt]!, signal); // an abort ends the wait; the retry then fails with it, unclassified
      // Each retry starts at the next endpoint: the one that rate-limited is the last asked.
      const again = await pass(chainId, missing.map((i) => calls[i]!), attempt + 1, policy, signal);
      missing.forEach((i, k) => {
        out[i] = again[k]!;
      });
    }
    return out;
  }

  return {
    slots,
    async results(chainId, calls, policy, signal) {
      const s = await slots(chainId, calls, policy, signal);
      const failed = s.find((x): x is {ok: false; failed: Error} => "failed" in x);
      if (failed) throw failed.failed;
      return s.map((x) => (x.ok ? x.result : null));
    },
  };
}
