import {httpRefusal, refusal, refusalOf, withReason} from "@anywalletkit/protocol-swap2-core/errors";
import {blockLackedInBody, nodeLacksBlock, redactUrls, timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";

export type RpcCall = {method: string; params: unknown[]};

/** Largest JSON-RPC batch sent to one node (X Layer's public RPCs refuse more than 10). */
export const RPC_BATCH_MAX = 10;

/** Pause before the endpoints are tried once more when the last one refused for its request rate. */
export const RPC_RATE_LIMIT_PAUSE_MS = 1_000;

/**
 * A batch element's error that is still an answer about the call: the EVM ran it and stopped (a revert — geth's code 3 —
 * an invalid opcode, out of gas). Anything else says nothing about the call — a rate limit inside an HTTP-200 batch
 * (QuickNode's -32007 "50/second request limit reached"), a node fault — and the batch goes to the next endpoint.
 */
export function isExecutionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const {code, message} = error as {code?: unknown; message?: unknown};
  return code === 3 || (typeof message === "string" && /revert|invalid opcode|out of gas/i.test(message));
}

/** A refusal for the request rate: HTTP 429, or JSON-RPC -32005 / -32007 / 429, or a message naming a limit. */
function isRateLimit(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const {code, message} = error as {code?: unknown; message?: unknown};
  return code === -32005 || code === -32007 || code === 429 || (typeof message === "string" && /rate|limit|too many/i.test(message));
}

const errorText = (error: unknown): string => {
  const m = error && typeof error === "object" ? (error as {message?: unknown}).message : undefined;
  return redactUrls(typeof m === "string" ? m : JSON.stringify(error) ?? String(error)).slice(0, 160);
};

/** Options of one {@link rpcClient} request. */
export interface RpcOptions {
  /**
   * The block the request is pinned to (`QuoteParams.blockNumber`, as its hex tag). An endpoint whose node says it
   * does not have that block, or no longer keeps its state ("header not found", "missing trie node"…), or answers a call
   * at it with no result, fails like a node fault: the next endpoint is asked, every endpoint once more after
   * {@link RPC_RATE_LIMIT_PAUSE_MS} (a node a block behind catches up), and then the request is refused as `stale_node`
   * naming the block — never asked at "latest" instead. Calls at another tag are as without it.
   */
  pinnedBlock?: string;
}

/** The block a call names (`eth_call` / `eth_getCode` second parameter). */
const tagOf = (call: RpcCall): unknown => call.params[1];

/**
 * JSON-RPC over the caller's endpoints for one chain: batches of at most {@link RPC_BATCH_MAX} calls, each batch tried
 * on the endpoints in order until one answers every call (once more after {@link RPC_RATE_LIMIT_PAUSE_MS} when the last
 * refusal was for the request rate, or — with {@link RpcOptions.pinnedBlock} — the node lacked the block). Each slot is
 * the result, or null when that call reverted — a revert is an answer, not a dead endpoint. An element error that is not
 * an execution error, or a call left unanswered, fails the endpoint: a rate-limited read is never returned as a missing
 * code or coin.
 */
export function rpcClient(rpcUrls: Readonly<Record<number, readonly string[]>>) {
  async function once(url: string, calls: RpcCall[], signal?: AbortSignal, pinned?: string): Promise<(unknown | null)[]> {
    const res = await fetch(url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(calls.map((c, id) => ({jsonrpc: "2.0", id, ...c}))),
      signal: signal ?? timeoutSignal(12_000),
    });
    /** The node lacks the pinned block: a fault of this endpoint, retried, then `stale_node` naming the block. */
    const lacks = (why: string) => withReason(Object.assign(new Error(`block ${BigInt(pinned!).toString()} is not served by the node (${why})`), {stale: true}), "stale_node");
    const pinnedCalls = pinned !== undefined && calls.some((c) => tagOf(c) === pinned);
    if (!res.ok && pinnedCalls) {
      // Some nodes answer a block they lack with an error status and a JSON-RPC body that says so (X Layer, Celo: 400
      // "block is out of range"; publicnode: 403 past its pruning): that, not the status, is the refusal.
      const lacked = blockLackedInBody(await res.text().catch(() => ""));
      if (lacked !== undefined) throw lacks(errorText({message: lacked}));
    }
    // A node's refusal by its status: 429 rate_limited (with Retry-After), 401 / 403 key_rejected, anything else upstream_unavailable.
    if (!res.ok) throw withReason(Object.assign(new Error(`HTTP ${res.status}`), {limited: res.status === 429}), httpRefusal(res.status, res.headers?.get?.("retry-after")) ?? {reason: "upstream_unavailable", httpStatus: res.status});
    const body = (await res.json()) as {id: number; result?: unknown; error?: unknown}[] | {error?: {message?: string}};
    if (!Array.isArray(body)) {
      if (pinnedCalls && nodeLacksBlock(body.error)) throw lacks(errorText(body.error));
      throw withReason(Object.assign(new Error(body.error?.message ?? "batch refused"), {limited: isRateLimit(body.error)}), isRateLimit(body.error) ? "rate_limited" : "upstream_unavailable");
    }
    const out: (unknown | null)[] = calls.map(() => null);
    const answered = new Set<number>();
    for (const r of body) {
      if (typeof r.id !== "number" || r.id < 0 || r.id >= out.length) continue;
      const atPin = pinned !== undefined && tagOf(calls[r.id]!) === pinned;
      if (r.error !== undefined && r.error !== null && !isExecutionError(r.error)) {
        if (atPin && nodeLacksBlock(r.error)) throw lacks(errorText(r.error));
        throw withReason(Object.assign(new Error(errorText(r.error)), {limited: isRateLimit(r.error)}), isRateLimit(r.error) ? "rate_limited" : "upstream_unavailable");
      }
      // An eth_call always names a result ("0x" at least): none at the pinned block is a node that lacks it, not a revert.
      if (atPin && (r.error === undefined || r.error === null) && (r.result === undefined || r.result === null)) throw lacks("the node answered a call with no result");
      answered.add(r.id);
      if (r.error === undefined || r.error === null) out[r.id] = r.result ?? null;
    }
    if (answered.size !== calls.length) throw refusal("upstream_unavailable", `answered ${answered.size} of ${calls.length} calls`);
    return out;
  }

  async function batch(chainId: number, calls: RpcCall[], signal?: AbortSignal, pinned?: string): Promise<(unknown | null)[]> {
    let lastErr: unknown;
    for (let pass = 0; pass < 2; pass++) {
      if (pass > 0) {
        const last = lastErr as {limited?: boolean; stale?: boolean} | undefined;
        if (!(last?.limited || last?.stale) || signal?.aborted) break;
        await new Promise((r) => setTimeout(r, RPC_RATE_LIMIT_PAUSE_MS));
      }
      for (const url of rpcUrls[chainId] ?? []) {
        try {
          return await once(url, calls, signal, pinned);
        } catch (e) {
          lastErr = e;
        }
      }
    }
    const error = new Error(`curve: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
    // Every endpoint failed: the last one's reason (throttled, a rejected key, the pinned block not served), else
    // upstream_unavailable — a node down, a timeout, an answer in another shape. The caller's own abort, or a chain with
    // no endpoint at all, stays unclassified.
    if (lastErr === undefined || signal?.aborted) throw error;
    throw withReason(error, refusalOf(lastErr) ?? "upstream_unavailable");
  }
  return async function rpc(chainId: number, calls: RpcCall[], signal?: AbortSignal, options?: RpcOptions): Promise<(unknown | null)[]> {
    const pinned = options?.pinnedBlock;
    if (calls.length <= RPC_BATCH_MAX) return batch(chainId, calls, signal, pinned);
    const chunks: RpcCall[][] = [];
    for (let i = 0; i < calls.length; i += RPC_BATCH_MAX) chunks.push(calls.slice(i, i + RPC_BATCH_MAX));
    return (await Promise.all(chunks.map((c) => batch(chainId, c, signal, pinned)))).flat();
  };
}

/** An `eth_call` at `block` ("latest" unless a quote is pinned to `QuoteParams.blockNumber`, as its hex tag). */
export const ethCall = (to: string, data: string, block: string = "latest"): RpcCall => ({method: "eth_call", params: [{to, data}, block]});

/** The first 32-byte ABI word of a return (whole words, at least one) as 64 lowercase hex, or null. */
function firstWord(raw: unknown): string | null {
  return typeof raw === "string" && raw.length >= 66 && /^0x(?:[0-9a-fA-F]{64})+$/.test(raw) ? raw.slice(2, 66).toLowerCase() : null;
}

/**
 * A return whose first ABI word holds an address → the address (lowercase), or null when the word's upper 12 bytes are
 * not zero. Only the first word is read: the Liquity factory metapool answers `coins(i)` with 4096 bytes.
 */
export function wordAddress(raw: unknown): string | null {
  const w = firstWord(raw);
  return w !== null && /^0{24}/.test(w) ? `0x${w.slice(24)}` : null;
}

/** A return's first ABI word → uint256, or null. */
export function wordUint(raw: unknown): bigint | null {
  const w = firstWord(raw);
  return w === null ? null : BigInt(`0x${w}`);
}
