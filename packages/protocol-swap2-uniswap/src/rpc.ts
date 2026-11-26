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
 * none left the chunk fails as `rate_limited`.
 */
export const RATE_WINDOW_MS = 1_000;
export const RATE_WAIT_MAX_MS = 4_000;
/**
 * `callsPerSecond`: how long after a quote began its batches may still be sent (`waitUntil`). A quote reads in up to
 * five passes one after another (deployment check, block, candidates, pools + probe, slot0), and each may wait for its
 * turn; bounded per batch only, a gated quote under load waited 4 s a pass and ran past the router's 8 s, aborted
 * unclassified (U0-LIVE-1). Bounded per quote, nothing of it is sent later — it is refused as `rate_limited` by then,
 * and its last pass still has 3 s to answer.
 */
export const QUOTE_WAIT_MAX_MS = 5_000;
/**
 * The lowest `rpcCallsPerSecond`: the least with which the largest quote fits QUOTE_WAIT_MAX_MS on an idle endpoint
 * that answers within 0.5 s — 51 calls in five passes one after another (4 deployment calls and the block read; with
 * `maxPriceImpactBps`, the latest block; 40 candidates; 2 pool lookups and the probe; 2 slot0() reads), batches of 10.
 * Below it a quote is refused as `rate_limited` with nothing else in the queue (U0C-1: at 5, every pair with two mid
 * tokens was, at once; tests/rate-floor-u0.test.ts; the provider refuses a lower one).
 */
export const MIN_CALLS_PER_SECOND = 13;
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
/**
 * Methods whose answer is never `null`: an `eth_call` returns bytes (`"0x"` at least) and `eth_blockNumber` a number,
 * so `null` from either is no answer (U0C-5: pinBlock took a null block number for an answer and never asked again).
 */
const NEVER_NULL: ReadonlySet<string> = new Set(["eth_call", "eth_blockNumber"]);
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

/** Longest error text kept in a refusal. */
const TEXT_MAX = 200;
/** Shortest piece of a configured URL taken out of error text on its own (a bare "/rpc" path is no secret). */
const URL_PART_MIN = 6;

/**
 * Every spelling of the chain's configured endpoints an error text may carry, longest first: the URL as given, without
 * its scheme (and so `//host/path`), as the URL parser writes it, and its host + path and path alone. A transport
 * error names the endpoint as it was given — "Failed to parse URL from rpc.example/v2/KEY" for one without a scheme,
 * which core `redactUrls` (anchored on `://`) cannot see (U0-SEC-R3-1).
 */
function urlSpellings(urls: readonly string[]): string[] {
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    if (s && s.length >= URL_PART_MIN) out.add(s);
  };
  for (const raw of urls) {
    const u = String(raw).trim();
    add(u);
    const bare = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/\//, "");
    add(bare);
    for (const text of [u, `https://${bare}`]) {
      try {
        const parsed = new URL(text);
        add(parsed.href);
        add(parsed.href.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""));
        add(`${parsed.host}${parsed.pathname}${parsed.search}`);
        if (parsed.pathname.length > 1 || parsed.search) add(`${parsed.pathname}${parsed.search}`);
        if (parsed.username || parsed.password) add(`${parsed.username}:${parsed.password}`);
      } catch {
        /* not a URL the parser takes: the spellings above stand */
      }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

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

export interface SlotOptions {
  /**
   * `callsPerSecond` only: the latest moment (ms since the epoch) a batch of this request may be booked for — a quote
   * passes its start + QUOTE_WAIT_MAX_MS. Past it nothing more is sent: a batch is refused as `rate_limited`, and a
   * call already unanswered keeps the reason it had (no retry is begun that could not be sent in time).
   */
  waitUntil?: number;
  /**
   * `callsPerSecond` only: the quote this request belongs to, numbered in the order quotes began (with `waitUntil`).
   * Turns go to the quote that began first: quotes begun in the same millisecond are told apart by it.
   */
  quote?: number;
  /**
   * Whether an answer is one the call can have (`index` into `calls`). One it cannot have — the quoter answers four
   * words or reverts, never `"0x"`, a number or bytes that do not decode — is no answer: retried as the policy allows,
   * then `upstream_unavailable` (U0-SEC-R3-2: the best pool dropped out silently and a worse route won).
   */
  accept?: (result: unknown, index: number) => boolean;
}

export interface UniswapRpc {
  /** Every call's outcome. Throws only for the caller's abort (unclassified) and, under `none` / `items`, for a chunk
   *  that no endpoint answered over HTTP (classified, as 0.4.11 threw it). */
  slots(chainId: number, calls: readonly RpcCall[], policy: RetryPolicy, signal?: AbortSignal, options?: SlotOptions): Promise<RpcSlot[]>;
  /** As 0.4.11's `rpc`: each slot the result, or null for a revert; any call without an answer throws its error. */
  results(chainId: number, calls: readonly RpcCall[], policy: RetryPolicy, signal?: AbortSignal, options?: SlotOptions): Promise<(unknown | null)[]>;
}

/** The caller's abort as an error (unclassified), as a fetch it cut short reports it. */
function abortError(chainId: number, signal?: AbortSignal): Error {
  const reason = (signal as {reason?: unknown} | undefined)?.reason as {message?: unknown} | undefined;
  return new Error(`uniswap: no RPC answered on chain ${chainId} (${typeof reason?.message === "string" ? reason.message : "This operation was aborted"})`);
}

export interface UniswapRpcOptions {
  /**
   * Most JSON-RPC calls sent to one endpoint in any RATE_WINDOW_MS, across every request of this instance (opt-in, an
   * integer ≥ 1 here; the provider asks for MIN_CALLS_PER_SECOND or more). Unset: no limit, every chunk goes at once
   * as 0.4.11 sent them. Set: batches carry at most this many calls, each waits for its turn on its endpoint (the quote
   * that began first, then first come first served; counted at the moment each batch went), and one that would wait more
   * than RATE_WAIT_MAX_MS, or go after its request's `waitUntil`, goes to the next endpoint instead.
   */
  callsPerSecond?: number;
}

/** A batch that went to an endpoint: when, and how many calls it carried. */
type Sent = {readonly at: number; readonly n: number};

/** Why a batch got no turn: it would wait more than RATE_WAIT_MAX_MS (`far`), or go after its `waitUntil` (`late`). */
type NoTurn = "far" | "late";

/**
 * A batch waiting for its turn on an endpoint. Turns go by priority — the start of the quote it belongs to (else when it
 * was asked), then first come first served — so a quote under way is not held behind quotes that began after it: a
 * quote's later passes go before newer quotes' first ones, and a burst serves the quotes it can instead of none (FIFO
 * kept every quote of a burst a pass behind the others until all ran out of time).
 */
interface Waiting {
  readonly n: number;
  /** Turn order: when its quote began (else when it was asked), the quote's number (none: after the quotes), then `seq`. */
  readonly prio: number;
  readonly quote: number;
  readonly seq: number;
  /** The latest it may go: RATE_WAIT_MAX_MS after it was asked, and never after its `waitUntil`. */
  readonly deadline: number;
  /** Which bound `deadline` is. */
  readonly bound: NoTurn;
  /** Its pass was given up on, or its caller aborted: it is dropped, unsent. */
  readonly cancelled: () => boolean;
  readonly answer: (turn: "go" | NoTurn | "cancelled") => void;
}

/** One endpoint under `callsPerSecond`: the batches sent in the last window, those waiting, and the timer for the next. */
interface Lane {
  sent: Sent[];
  waiting: Waiting[];
  timer?: ReturnType<typeof setTimeout> | undefined;
}

export function uniswapRpc(rpcUrls: Readonly<Record<number, readonly string[]>>, options: UniswapRpcOptions = {}): UniswapRpc {
  const rate = options.callsPerSecond;
  if (rate !== undefined && !(Number.isInteger(rate) && rate >= 1)) throw new Error("uniswap: rpcCallsPerSecond must be an integer ≥ 1");
  const batchMax = rate === undefined ? RPC_BATCH_MAX : Math.min(RPC_BATCH_MAX, rate);
  /** Per endpoint (`callsPerSecond` only). */
  const lanes = new Map<string, Lane>();
  let seq = 0;
  /** Per chain: the spellings of its endpoints that are taken out of error text. */
  const spellings = new Map<number, string[]>();
  /** Chunk failures that are only "past the request's waitUntil" on every endpoint (never sent): no news about the calls. */
  const late = new WeakSet<Error>();

  /** Error text as a refusal may carry it: the chain's own endpoints and any URL taken out, kept short. */
  function clean(chainId: number, text: string): string {
    let list = spellings.get(chainId);
    if (!list) spellings.set(chainId, (list = urlSpellings(rpcUrls[chainId] ?? [])));
    // Cut before taking out (bounded work), but past where a spelling that starts inside the kept text ends.
    let t = text.slice(0, TEXT_MAX + (list[0]?.length ?? 0));
    for (const u of list) if (t.includes(u)) t = t.split(u).join("<url>");
    return redactUrls(t).slice(0, TEXT_MAX);
  }
  /** A node's error as refusal text: code and message, cleaned (a keyed endpoint may echo its own URL). */
  const describe = (chainId: number, e: RpcItemError) => clean(chainId, e.code !== undefined ? `${e.code} ${e.message}` : e.message);

  /**
   * The earliest moment from `from` at which `n` more calls fit the window, given what went (`sent`, in order): no window
   * of RATE_WINDOW_MS then holds more than `rate` calls, counted at the moment each batch went.
   */
  function roomAt(sent: readonly Sent[], n: number, from: number): number {
    let inWindow = n;
    for (const x of sent) if (x.at > from - RATE_WINDOW_MS) inWindow += x.n;
    for (const x of sent) {
      if (inWindow <= rate!) break;
      if (x.at > from - RATE_WINDOW_MS) {
        inWindow -= x.n;
        from = x.at + RATE_WINDOW_MS;
      }
    }
    return from;
  }

  /** When each waiting batch would go, in turn order (a batch past its deadline is dropped and takes no room). */
  function plan(lane: Lane, extra: Waiting | undefined, now: number): Map<Waiting, number> {
    const order = extra ? [...lane.waiting, extra].sort(byTurn) : lane.waiting;
    const sent = lane.sent.slice();
    const at = new Map<Waiting, number>();
    let t = now;
    for (const w of order) {
      if (w.cancelled()) continue;
      const go = roomAt(sent, w.n, t);
      if (go > w.deadline) continue;
      at.set(w, go);
      sent.push({at: go, n: w.n});
      t = go;
    }
    return at;
  }
  const byTurn = (x: Waiting, y: Waiting) => x.prio - y.prio || (x.quote === y.quote ? 0 : x.quote < y.quote ? -1 : 1) || x.seq - y.seq;

  /**
   * Gives every waiting batch whose turn has come its turn, refuses the ones that can no longer go in time (a quote that
   * began earlier took their turns) or were cancelled, and sets the timer for the next turn.
   */
  function pump(lane: Lane): void {
    if (lane.timer !== undefined) clearTimeout(lane.timer);
    lane.timer = undefined;
    const now = Date.now();
    lane.sent = lane.sent.filter((x) => x.at > now - RATE_WINDOW_MS);
    for (;;) {
      const at = plan(lane, undefined, now);
      lane.waiting = lane.waiting.filter((w) => {
        if (w.cancelled()) w.answer("cancelled");
        else if (!at.has(w)) w.answer(w.bound);
        else return true;
        return false;
      });
      const head = lane.waiting[0];
      if (!head) return;
      const go = at.get(head)!;
      if (go > now) {
        lane.timer = setTimeout(() => pump(lane), go - now);
        return;
      }
      lane.waiting.shift();
      lane.sent.push({at: now, n: head.n});
      head.answer("go");
    }
  }

  /**
   * Waits for `n` calls' turn on `url`: "go" when they may be sent (counted as sent then); a NoTurn when it can no longer
   * go in time — at once, when the turns ahead of it already put it past RATE_WAIT_MAX_MS or `waitUntil`, or later, as
   * soon as the turns of a quote that began earlier push it there; "cancelled" for an abort or a pass given up on.
   */
  function turn(url: string, n: number, o: SlotOptions, signal: AbortSignal | undefined, abandoned: () => boolean): Promise<"go" | NoTurn | "cancelled"> {
    const {waitUntil} = o;
    let lane = lanes.get(url);
    if (!lane) lanes.set(url, (lane = {sent: [], waiting: []}));
    const now = Date.now();
    lane.sent = lane.sent.filter((x) => x.at > now - RATE_WINDOW_MS);
    const far = now + RATE_WAIT_MAX_MS;
    const quoteBound = waitUntil !== undefined && waitUntil < far;
    return new Promise((resolve) => {
      let done = false;
      const onAbort = () => pump(lane!);
      const w: Waiting = {
        n,
        prio: waitUntil !== undefined ? waitUntil - QUOTE_WAIT_MAX_MS : now,
        quote: o.quote ?? Number.POSITIVE_INFINITY,
        seq: seq++,
        deadline: quoteBound ? waitUntil! : far,
        bound: quoteBound ? "late" : "far",
        cancelled: () => !!signal?.aborted || abandoned(),
        answer: (t) => {
          if (done) return;
          done = true;
          signal?.removeEventListener?.("abort", onAbort);
          resolve(t);
        },
      };
      if (w.cancelled()) return w.answer("cancelled");
      // Refused at once when the turns ahead of it already leave it none in time: the next endpoint is asked now.
      if (!plan(lane!, w, now).has(w)) return w.answer(w.bound);
      lane!.waiting.push(w);
      lane!.waiting.sort(byTurn);
      signal?.addEventListener?.("abort", onAbort, {once: true});
      pump(lane!);
    });
  }

  /**
   * One chunk over the endpoints (starting at `start`), each slot its answer — or a ChunkFailure when none answered.
   * Under `callsPerSecond`, a chunk the pass has given up on (`abandoned`) while it waited for its turn is not sent.
   */
  async function chunk(chainId: number, calls: readonly RpcCall[], start: number, signal: AbortSignal | undefined, abandoned: () => boolean, o: SlotOptions): Promise<RpcSlot[]> {
    const urls = rpcUrls[chainId] ?? [];
    let lastErr: unknown;
    let jsonRpc = false;
    let onlyLate = rate !== undefined && urls.length > 0; // every endpoint refused it for waitUntil alone
    for (let k = 0; k < urls.length; k++) {
      const url = urls[(start + k) % urls.length]!;
      if (rate !== undefined) {
        const t = await turn(url, calls.length, o, signal, abandoned);
        if (t === "cancelled" || signal?.aborted || abandoned()) throw abortError(chainId, signal); // the caller's abort; or a pass that has already failed (nobody reads it)
        if (t !== "late") onlyLate = false;
        if (t !== "go") {
          lastErr = refusal("rate_limited", t === "far"
            ? `the endpoint's ${rate} calls a second are booked more than ${RATE_WAIT_MAX_MS / 1000} s ahead`
            : `the endpoint's ${rate} calls a second are booked past ${QUOTE_WAIT_MAX_MS / 1000} s into the quote`);
          jsonRpc = false;
          continue;
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
          throw withReason(new Error(body.error?.message !== undefined ? describe(chainId, {message: String(body.error.message)}) : "batch refused"), kind === "revert" ? "upstream_unavailable" : kind);
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
            // An answer must carry its result: an item with neither, or `null` from a call that always names one
            // (eth_call, eth_blockNumber), is no answer (it was read as a revert before, so the best pool dropped out
            // silently). `null` stays an answer where it means one (a receipt not mined yet).
            out[r.id] = !Object.prototype.hasOwnProperty.call(r, "result") || (r.result === null && NEVER_NULL.has(calls[r.id]!.method))
              ? {ok: false, failed: refusal("upstream_unavailable", `uniswap: no RPC answered on chain ${chainId} (the node answered a call with no result)`)}
              : {ok: true, result: r.result};
            continue;
          }
          const e = itemError(r.error);
          const kind = rpcErrorKind(e);
          out[r.id] = kind === "revert" ? {ok: false, revert: e} : {ok: false, failed: refusal(kind, `uniswap: no RPC answered on chain ${chainId} (${describe(chainId, e)})`)};
        }
        const unanswered = (): RpcSlot => {
          if (idless === undefined) return {ok: false, failed: refusal("upstream_unavailable", `uniswap: no RPC answered on chain ${chainId} (the node left a call unanswered)`)};
          const kind = rpcErrorKind(idless);
          return {ok: false, failed: refusal(kind === "revert" ? "upstream_unavailable" : kind, `uniswap: no RPC answered on chain ${chainId} (${describe(chainId, idless)})`)};
        };
        return out.map((s) => s ?? unanswered());
      } catch (e) {
        lastErr = e;
        jsonRpc = batchRefused;
      }
    }
    // A transport error may carry the endpoint itself (Node's fetch names the URL it was given, scheme or not): taken out.
    const error = new Error(`uniswap: no RPC answered on chain ${chainId} (${clean(chainId, lastErr instanceof Error ? lastErr.message : String(lastErr))})`);
    // Every endpoint failed: the last one's own classification (a 429, a rejected key), else unavailable — never the caller's abort.
    if (signal?.aborted) throw error;
    const classified = withReason(error, refusalOf(lastErr) ?? "upstream_unavailable");
    if (onlyLate) late.add(classified);
    throw new ChunkFailure(classified, jsonRpc);
  }

  /**
   * The calls in chunks (RPC_BATCH_MAX, or `callsPerSecond` when lower), all sent at once as 0.4.11 sent them (under
   * `callsPerSecond`, each when its endpoint has room). A chunk failure the policy does not retry fails the pass; it
   * stays failed, and under `callsPerSecond` the chunks still waiting for their turn are then not sent.
   */
  async function pass(chainId: number, calls: readonly RpcCall[], start: number, policy: RetryPolicy, signal: AbortSignal | undefined, o: SlotOptions): Promise<RpcSlot[]> {
    const chunks: RpcCall[][] = [];
    for (let i = 0; i < calls.length; i += batchMax) chunks.push(calls.slice(i, i + batchMax));
    let failed = false;
    const one = async (c: RpcCall[]): Promise<RpcSlot[]> => {
      try {
        return await chunk(chainId, c, start, signal, () => failed, o);
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

  async function slots(chainId: number, calls: readonly RpcCall[], policy: RetryPolicy, signal?: AbortSignal, o: SlotOptions = {}): Promise<RpcSlot[]> {
    /** An answer the call cannot have is no answer (SlotOptions.accept). */
    const vet = (s: RpcSlot, i: number): RpcSlot =>
      s.ok && o.accept && !o.accept(s.result, i)
        ? {ok: false, failed: refusal("upstream_unavailable", `uniswap: no RPC answered on chain ${chainId} (the node answered a call in a shape the contract never returns)`)}
        : s;
    const out = (await pass(chainId, calls, 0, policy, signal, o)).map(vet);
    if (policy === "none") return out;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      const missing = out.flatMap((s, i) => ("failed" in s ? [i] : []));
      if (missing.length === 0) break;
      const [from, to] = RETRY_DELAYS_MS[attempt]!;
      // A retry that could only go after waitUntil is not begun: the calls keep the reasons they have.
      if (rate !== undefined && o.waitUntil !== undefined && Date.now() + from > o.waitUntil) break;
      await pause(from + Math.floor(Math.random() * (to - from + 1)), signal); // an abort ends the wait; the retry then fails with it, unclassified
      // Each retry starts at the next endpoint: the one that rate-limited is the last asked.
      const again = await pass(chainId, missing.map((i) => calls[i]!), attempt + 1, policy, signal, o);
      missing.forEach((i, k) => {
        const s = again[k]!;
        // Refused only for being past waitUntil (never sent): the call keeps the reason it was unanswered for.
        if (!("failed" in s && late.has(s.failed))) out[i] = vet(s, i);
      });
    }
    return out;
  }

  return {
    slots,
    async results(chainId, calls, policy, signal, o) {
      const s = await slots(chainId, calls, policy, signal, o);
      const failed = s.find((x): x is {ok: false; failed: Error} => "failed" in x);
      if (failed) throw failed.failed;
      return s.map((x) => (x.ok ? x.result : null));
    },
  };
}
