import {anySignal, redactUrls, timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
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

/** How long one batch may take on one endpoint before the next endpoint is asked (ms). */
const RPC_TIMEOUT_MS = 12_000;
/** Largest JSON-RPC batch sent to one node (X Layer's public RPCs refuse more than 10). */
export const RPC_BATCH_MAX = 10;
/**
 * `callsPerSecond` (opt-in): the window it counts calls in, per endpoint, and the longest a batch waits for its turn.
 * A batch that would wait longer is not queued: that endpoint is rate-limited for it, the next one is asked, and with
 * none left the chunk fails as `rate_limited` — so a queue never outgrows what a caller (the router allows a quote 8 s)
 * would still wait for, with or without a signal.
 */
export const RATE_WINDOW_MS = 1_000;
export const RATE_WAIT_MAX_MS = 4_000;
/**
 * Waits before each retry (ms, from..to): long enough for a per-second window to pass, spread at random so that
 * concurrent quotes refused in the same window do not all come back in the next one together.
 */
export const RETRY_DELAYS_MS: readonly (readonly [number, number])[] = [[300, 600], [1000, 1500]];

/** JSON-RPC codes nodes use for "too many requests" (EIP-1474 -32005; QuickNode -32007; OnFinality -32029; others). */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([429, -32005, -32007, -32011, -32029, -32090]);
const RATE_LIMIT_TEXT = /rate.?limit|too many|request limit|limit (?:reached|exceeded)|exceeds? (?:the )?limit|throttl|capacity|quota/i;
/** The call ran and the EVM stopped it: a revert, or the gas the node lets one call use ran out (an answer either way). */
const REVERT_TEXT = /revert|out of gas|gas required exceeds|gas limit reached|invalid opcode|invalid jump|stack (?:underflow|overflow|limit reached)|max call depth exceeded|write protection|return data out of bounds|vm execution error/i;
/** The node failed to run the call: hex `data` next to these is not revert bytes. */
const NODE_FAULT_TEXT = /timeout|timed out|unavailable|internal error|overload|busy|try again|header not found|missing trie node/i;

/**
 * A per-item JSON-RPC error read as a revert (the call ran: an answer) or as the reason the node did not answer:
 * - code 3 (geth, reth, Monad) is a revert, whatever its text;
 * - a rate-limit code (`-32005`, `-32007`, `429`…) is `rate_limited`;
 * - a revert or other EVM-error text (`-32000 "execution reverted"`, Besu, Erigon, an empty revert, out of gas, geth's
 *   `stack limit reached 1024 (1023)` — read before the rate-limit text, which "limit reached" would also match) is a revert;
 * - a rate-limit text is `rate_limited`, before `data` is looked at (`{-32000, "rate limit exceeded", data: "0x…"}`);
 * - revert bytes in `data` are a revert, unless the text names a node fault (`-32603 "internal error"`, a timeout);
 * - anything else (`header not found`, `missing trie node`, an internal error) is `upstream_unavailable` — never "no pool".
 */
export function rpcErrorKind(error: RpcItemError): "revert" | Extract<Swap2RefusalReason, "rate_limited" | "upstream_unavailable"> {
  if (error.code === 3) return "revert";
  if (typeof error.code === "number" && RATE_LIMIT_CODES.has(error.code)) return "rate_limited";
  if (REVERT_TEXT.test(error.message)) return "revert";
  if (RATE_LIMIT_TEXT.test(error.message)) return "rate_limited";
  if (typeof error.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(error.data) && !NODE_FAULT_TEXT.test(error.message)) return "revert";
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

/** The caller's abort as an error (unclassified), as a fetch it cut short reports it. */
function abortError(chainId: number, signal?: AbortSignal): Error {
  const reason = (signal as {reason?: unknown} | undefined)?.reason as {message?: unknown} | undefined;
  return new Error(`uniswap: no RPC answered on chain ${chainId} (${typeof reason?.message === "string" ? reason.message : "This operation was aborted"})`);
}

export interface UniswapRpcOptions {
  /**
   * Most JSON-RPC calls sent to one endpoint in any RATE_WINDOW_MS, across every request of this instance (opt-in, an
   * integer ≥ 1). Unset: no limit, every chunk goes at once as 0.4.11 sent them. Set: batches carry at most this many
   * calls, each waits for its turn on its endpoint (first come, first served), and one that would wait more than
   * RATE_WAIT_MAX_MS goes to the next endpoint instead.
   */
  callsPerSecond?: number;
}

/** One batch booked on an endpoint: when it goes and how many calls it carries. */
type Booking = {readonly at: number; readonly n: number};

export function uniswapRpc(rpcUrls: Readonly<Record<number, readonly string[]>>, options: UniswapRpcOptions = {}): UniswapRpc {
  const rate = options.callsPerSecond;
  if (rate !== undefined && !(Number.isInteger(rate) && rate >= 1)) throw new Error("uniswap: rpcCallsPerSecond must be an integer ≥ 1");
  const batchMax = rate === undefined ? RPC_BATCH_MAX : Math.min(RPC_BATCH_MAX, rate);
  /** Per endpoint (`callsPerSecond` only): the batches sent in the last window and booked after it, in send order. */
  const booked = new Map<string, Booking[]>();

  /**
   * Books `n` calls (n ≤ rate) on `url` at the earliest moment, no sooner than the batches booked before it, at which no
   * window of RATE_WINDOW_MS holds more than `rate` calls; undefined (nothing booked) when that is over RATE_WAIT_MAX_MS
   * away. Every window that ends at or after the new booking lies inside the one checked, so the bound holds for all.
   */
  function book(url: string, n: number, limit: number): Booking | undefined {
    const now = Date.now();
    let log = booked.get(url);
    if (!log) booked.set(url, (log = []));
    while (log.length > 0 && log[0]!.at <= now - RATE_WINDOW_MS) log.shift();
    let at = log.length > 0 ? Math.max(now, log[log.length - 1]!.at) : now;
    let inWindow = 0;
    for (const b of log) inWindow += b.n;
    let i = 0;
    const leave = () => {
      while (i < log!.length && log![i]!.at <= at - RATE_WINDOW_MS) inWindow -= log![i++]!.n;
    };
    leave();
    while (inWindow + n > limit && i < log.length) {
      at = log[i]!.at + RATE_WINDOW_MS;
      leave();
    }
    if (at - now > RATE_WAIT_MAX_MS) return undefined;
    const b: Booking = {at, n};
    log.push(b);
    return b;
  }

  function unbook(url: string, b: Booking): void {
    const log = booked.get(url);
    const at = log ? log.indexOf(b) : -1;
    if (at >= 0) log!.splice(at, 1);
  }

  /**
   * One chunk over the endpoints (starting at `start`), each slot its answer — or a ChunkFailure when none answered.
   * Under `callsPerSecond`, a chunk the pass has given up on (`abandoned`) while it waited for its turn is not sent.
   */
  async function chunk(chainId: number, calls: readonly RpcCall[], start: number, signal: AbortSignal | undefined, abandoned: () => boolean): Promise<RpcSlot[]> {
    const urls = rpcUrls[chainId] ?? [];
    let lastErr: unknown;
    let jsonRpc = false;
    for (let k = 0; k < urls.length; k++) {
      const url = urls[(start + k) % urls.length]!;
      if (rate !== undefined) {
        const b = book(url, calls.length, rate);
        if (!b) {
          lastErr = refusal("rate_limited", `the endpoint's ${rate} calls a second are booked more than ${RATE_WAIT_MAX_MS / 1000} s ahead`);
          jsonRpc = false;
          continue;
        }
        if (b.at > Date.now()) await pause(b.at - Date.now(), signal);
        if (signal?.aborted || abandoned()) {
          unbook(url, b);
          throw abortError(chainId, signal); // the caller's abort; or a pass that has already failed (nobody reads it)
        }
      }
      let batchRefused = false;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify(calls.map((c, id) => ({jsonrpc: "2.0", id, ...c}))),
          // Bounded even under the caller's signal: a hung endpoint is left for the next one after RPC_TIMEOUT_MS.
          signal: signal ? anySignal([signal, timeoutSignal(RPC_TIMEOUT_MS)]) : timeoutSignal(RPC_TIMEOUT_MS),
        });
        if (!res.ok) {
          const error = new Error(`HTTP ${res.status}`);
          const info = httpRefusal(res.status, res.headers?.get?.("retry-after"));
          throw info ? withReason(error, info) : error;
        }
        const body = (await res.json()) as {id: unknown; result?: unknown; error?: unknown}[] | {error?: {message?: string}};
        if (!Array.isArray(body)) {
          // The whole batch refused with a JSON-RPC error (a rate limit, a batch-size cap): no call was answered.
          const e = itemError(body.error);
          const kind = rpcErrorKind(e);
          batchRefused = true;
          throw withReason(new Error(body.error?.message !== undefined ? describe({message: String(body.error.message)}) : "batch refused"), kind === "revert" ? "upstream_unavailable" : kind);
        }
        const out: (RpcSlot | undefined)[] = calls.map(() => undefined);
        /** An error the node sent without a usable id (a batch-level rate limit as an array entry): the unanswered calls' reason. */
        let idless: RpcItemError | undefined;
        for (const r of body) {
          if (!r || typeof r !== "object") continue;
          if (typeof r.id !== "number" || !Number.isInteger(r.id) || r.id < 0 || r.id >= out.length) {
            if (idless === undefined && (r.id === null || r.id === undefined) && r.error !== undefined && r.error !== null) idless = itemError(r.error);
            continue;
          }
          if (r.error === undefined) {
            // An answer must carry its result: an item with neither, or eth_call's `null`, is no answer (it was read as
            // a revert before, so the best pool dropped out silently). `null` stays an answer where it means one (a
            // receipt not mined yet).
            out[r.id] = !Object.prototype.hasOwnProperty.call(r, "result") || (r.result === null && calls[r.id]!.method === "eth_call")
              ? {ok: false, failed: refusal("upstream_unavailable", `uniswap: no RPC answered on chain ${chainId} (the node answered a call with no result)`)}
              : {ok: true, result: r.result};
            continue;
          }
          const e = itemError(r.error);
          const kind = rpcErrorKind(e);
          out[r.id] = kind === "revert" ? {ok: false, revert: e} : {ok: false, failed: refusal(kind, `uniswap: no RPC answered on chain ${chainId} (${describe(e)})`)};
        }
        const unanswered = (): RpcSlot => {
          if (idless === undefined) return {ok: false, failed: refusal("upstream_unavailable", `uniswap: no RPC answered on chain ${chainId} (the node left a call unanswered)`)};
          const kind = rpcErrorKind(idless);
          return {ok: false, failed: refusal(kind === "revert" ? "upstream_unavailable" : kind, `uniswap: no RPC answered on chain ${chainId} (${describe(idless)})`)};
        };
        return out.map((s) => s ?? unanswered());
      } catch (e) {
        lastErr = e;
        jsonRpc = batchRefused;
      }
    }
    // A transport error may carry the endpoint itself (Node's fetch names a URL with credentials): taken out.
    const error = new Error(`uniswap: no RPC answered on chain ${chainId} (${redactUrls(lastErr instanceof Error ? lastErr.message : String(lastErr))})`);
    // Every endpoint failed: the last one's own classification (a 429, a rejected key), else unavailable — never the caller's abort.
    if (signal?.aborted) throw error;
    throw new ChunkFailure(withReason(error, refusalOf(lastErr) ?? "upstream_unavailable"), jsonRpc);
  }

  /**
   * The calls in chunks (RPC_BATCH_MAX, or `callsPerSecond` when lower), all sent at once as 0.4.11 sent them (under
   * `callsPerSecond`, each when its endpoint has room). A chunk failure the policy does not retry fails the pass; it
   * stays failed, and under `callsPerSecond` the chunks still waiting for their turn are then not sent.
   */
  async function pass(chainId: number, calls: readonly RpcCall[], start: number, policy: RetryPolicy, signal?: AbortSignal): Promise<RpcSlot[]> {
    const chunks: RpcCall[][] = [];
    for (let i = 0; i < calls.length; i += batchMax) chunks.push(calls.slice(i, i + batchMax));
    let failed = false;
    const one = async (c: RpcCall[]): Promise<RpcSlot[]> => {
      try {
        return await chunk(chainId, c, start, signal, () => failed);
      } catch (e) {
        // Under `all` (and `items` for a JSON-RPC-level refusal) the chunk's calls are retried like any unanswered call.
        const retryable = isChunkFailure(e) && (policy === "all" || (policy === "items" && e.jsonRpc));
        if (!retryable) failed = true;
        if (!isChunkFailure(e)) throw e; // the caller's abort
        if (!retryable) throw e.error;
        return c.map(() => ({ok: false, failed: e.error}));
      }
    };
    return (await Promise.all(chunks.map(one))).flat();
  }

  async function slots(chainId: number, calls: readonly RpcCall[], policy: RetryPolicy, signal?: AbortSignal): Promise<RpcSlot[]> {
    const out = await pass(chainId, calls, 0, policy, signal);
    if (policy === "none") return out;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      const missing = out.flatMap((s, i) => ("failed" in s ? [i] : []));
      if (missing.length === 0) break;
      const [from, to] = RETRY_DELAYS_MS[attempt]!;
      await pause(from + Math.floor(Math.random() * (to - from + 1)), signal); // an abort ends the wait; the retry then fails with it, unclassified
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
