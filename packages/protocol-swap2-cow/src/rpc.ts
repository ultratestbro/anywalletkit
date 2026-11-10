/**
 * JSON-RPC reads the module makes on its own: permit detection, allowance-free simulation of the permit call,
 * eth-flow order state, receiver code. Endpoints are the caller's (`rpcUrls`); without them the module still
 * quotes and builds — the reads are extra checks, the signed order stays bound by the engine either way.
 */
import {timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";

export interface CowRpc {
  /** True when at least one endpoint is configured for the chain. */
  has(chainId: number): boolean;
  /** One JSON-RPC call; an error the node answered carries `rpc: true` (and `data`), "no endpoint answered" does not. */
  request(chainId: number, method: string, params: unknown[]): Promise<unknown>;
  /** `eth_call` at the latest block; the returned bytes (hex). */
  call(chainId: number, to: string, data: string): Promise<string>;
}

/** True for an error a node answered (a revert, a refused method) — as opposed to no node answering at all. */
export const isRpcAnswer = (e: unknown): boolean => (e as {rpc?: boolean} | null)?.rpc === true;

export function cowRpc(rpcUrls: Readonly<Record<number, readonly string[]>> | undefined): CowRpc {
  const urls = (chainId: number): readonly string[] => (rpcUrls && Object.prototype.hasOwnProperty.call(rpcUrls, chainId) ? rpcUrls[chainId] ?? [] : []);
  async function request(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    let lastErr: unknown;
    for (const url of urls(chainId)) {
      try {
        const res = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal: timeoutSignal(12_000)});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {result?: unknown; error?: {message?: string; data?: unknown}};
        if (body.error) throw Object.assign(new Error(typeof body.error.message === "string" ? body.error.message.slice(0, 200) : "rpc error"), {rpc: true, data: body.error.data});
        return body.result ?? null;
      } catch (e) {
        if (isRpcAnswer(e)) throw e;
        lastErr = e;
      }
    }
    throw new Error(`cow: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.name : "none configured"})`);
  }
  return {
    has: (chainId) => urls(chainId).length > 0,
    request,
    async call(chainId, to, data) {
      const out = await request(chainId, "eth_call", [{to, data}, "latest"]);
      if (typeof out !== "string" || !/^0x(?:[0-9a-fA-F]{2}){0,4096}$/.test(out)) throw new Error("cow: malformed eth_call result");
      return out;
    },
  };
}
