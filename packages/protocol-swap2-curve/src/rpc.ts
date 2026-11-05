import {timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";

export type RpcCall = {method: string; params: unknown[]};

/** Largest JSON-RPC batch sent to one node (X Layer's public RPCs refuse more than 10). */
export const RPC_BATCH_MAX = 10;

/**
 * JSON-RPC over the caller's endpoints for one chain: batches of at most {@link RPC_BATCH_MAX} calls, each batch tried
 * on the endpoints in order until one answers. Each slot is the result, or null when that call reverted or errored —
 * a revert is an answer, not a dead endpoint.
 */
export function rpcClient(rpcUrls: Readonly<Record<number, readonly string[]>>) {
  async function batch(chainId: number, calls: RpcCall[], signal?: AbortSignal): Promise<(unknown | null)[]> {
    let lastErr: unknown;
    for (const url of rpcUrls[chainId] ?? []) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify(calls.map((c, id) => ({jsonrpc: "2.0", id, ...c}))),
          signal: signal ?? timeoutSignal(12_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {id: number; result?: unknown; error?: unknown}[] | {error?: {message?: string}};
        if (!Array.isArray(body)) throw new Error(body.error?.message ?? "batch refused");
        const out: (unknown | null)[] = calls.map(() => null);
        for (const r of body) if (typeof r.id === "number" && r.id >= 0 && r.id < out.length && r.error === undefined) out[r.id] = r.result ?? null;
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`curve: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
  }
  return async function rpc(chainId: number, calls: RpcCall[], signal?: AbortSignal): Promise<(unknown | null)[]> {
    if (calls.length <= RPC_BATCH_MAX) return batch(chainId, calls, signal);
    const chunks: RpcCall[][] = [];
    for (let i = 0; i < calls.length; i += RPC_BATCH_MAX) chunks.push(calls.slice(i, i + RPC_BATCH_MAX));
    return (await Promise.all(chunks.map((c) => batch(chainId, c, signal)))).flat();
  };
}

export const ethCall = (to: string, data: string): RpcCall => ({method: "eth_call", params: [{to, data}, "latest"]});

/** A 32-byte ABI word holding an address → the address (lowercase), or null. */
export function wordAddress(raw: unknown): string | null {
  return typeof raw === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw) ? `0x${raw.slice(-40)}`.toLowerCase() : null;
}

/** A 32-byte ABI word → uint256, or null. */
export function wordUint(raw: unknown): bigint | null {
  return typeof raw === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw) ? BigInt(raw) : null;
}
