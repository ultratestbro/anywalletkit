/**
 * Minimal JSON-RPC over the integrator's own endpoints (Hermes-safe: `timeoutSignal`, no AbortSignal.timeout).
 * The first endpoint that gives a JSON-RPC answer wins; an execution error is an answer, a transport failure is not.
 */
import {timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";

export type RpcUrls = Readonly<Record<number, readonly string[]>>;
export type RpcAnswer = {result: unknown} | {error: {code: unknown; message: string}};

const RPC_TIMEOUT_MS = 12_000;

/** The endpoints configured for `chainId` (own property only). */
export function rpcUrlsFor(rpcUrls: RpcUrls | undefined, chainId: number): readonly string[] {
  if (!rpcUrls || !Object.prototype.hasOwnProperty.call(rpcUrls, chainId)) return [];
  const urls = rpcUrls[chainId];
  return Array.isArray(urls) ? urls.filter((u): u is string => typeof u === "string" && u.length > 0) : [];
}

/** One request; null when no endpoint is configured or none answered. */
export async function rpcRequest(rpcUrls: RpcUrls | undefined, chainId: number, method: string, params: unknown[]): Promise<RpcAnswer | null> {
  for (const url of rpcUrlsFor(rpcUrls, chainId)) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
        signal: timeoutSignal(RPC_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {result?: unknown; error?: {code?: unknown; message?: unknown} | null} | null;
      if (!body || typeof body !== "object") continue;
      if (body.error) return {error: {code: body.error.code, message: typeof body.error.message === "string" ? body.error.message : "rpc error"}};
      if ("result" in body) return {result: body.result ?? null};
    } catch {
      // next endpoint
    }
  }
  return null;
}

/** Whether a JSON-RPC error says the call itself reverted (as opposed to the endpoint failing). */
export function isRevert(error: {code: unknown; message: string}): boolean {
  return error.code === 3 || /revert/i.test(error.message);
}
