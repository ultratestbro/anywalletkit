export type LayerZeroApiErrorCode = "config" | "aborted" | "timeout" | "transport" | "http" | "schema" | "server-only";
/** Never exposes an upstream body, URL, header, key or transport cause. */
export class LayerZeroApiError extends Error {
  constructor(readonly code: LayerZeroApiErrorCode, readonly status?: number) {
    super(`layerzero: ${code}${status === undefined ? "" : ` (${status})`}`);
    this.name = "LayerZeroApiError";
  }
}
export interface LayerZeroApiConfig {
  /** HTTPS API/proxy root; no credentials, query string or fragment. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Total request deadline, including retry waits; default 20 seconds. */
  timeoutMs?: number;
  /** Only read-only GETs retry 429/503; default 2, at most 3. POSTs never retry. */
  readRetries?: number;
}
export function assertApi(condition: unknown): asserts condition { if (!condition) throw new LayerZeroApiError("schema"); }
export function record(value: unknown): Record<string, unknown> {
  assertApi(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function textField(value: unknown, max = 1024): string {
  assertApi(typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value));
  return value;
}
export function amountField(value: unknown): string {
  assertApi(typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n);
  return value;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new LayerZeroApiError("aborted")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, {once: true});
  });
}
export function apiTransport(config: LayerZeroApiConfig, apiKey?: string) {
  let base: URL;
  try { base = new URL(config.baseUrl ?? "https://transfer.layerzero-api.com/v1"); } catch { throw new LayerZeroApiError("config"); }
  const timeout = config.timeoutMs ?? 20_000, retries = config.readRetries ?? 2;
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000 || !Number.isSafeInteger(retries) || retries < 0 || retries > 3) throw new LayerZeroApiError("config");
  const root = base.href.replace(/\/+$/, ""), fetchImpl = config.fetchImpl ?? fetch;
  return async (path: string, params?: URLSearchParams | Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) throw new LayerZeroApiError("aborted");
    signal?.addEventListener("abort", abort, {once: true});
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const get = params === undefined || params instanceof URLSearchParams;
    try {
      for (let attempt = 0; ; attempt++) {
        if (controller.signal.aborted) throw new LayerZeroApiError("aborted");
        const response = await fetchImpl(`${root}/${path}${params instanceof URLSearchParams && params.toString() ? `?${params}` : ""}`, {
          method: get ? "GET" : "POST", redirect: "error", signal: controller.signal,
          headers: {accept: "application/json", ...(!get ? {"content-type": "application/json"} : {}), ...(apiKey ? {"x-api-key": apiKey} : {})},
          ...(!get ? {body: JSON.stringify(params)} : {}),
        });
        if (get && (response.status === 429 || response.status === 503) && attempt < retries) {
          const header = response.headers.get("retry-after");
          const ms = header === null ? 250 * 2 ** attempt : /^\d+$/.test(header) ? parseInt(header, 10) * 1000 : Date.parse(header) - Date.now();
          if (response.body) await response.body.cancel();
          if (!Number.isFinite(ms) || ms < 0 || ms > timeout) throw new LayerZeroApiError("http", response.status);
          await delay(ms, controller.signal);
          continue;
        }
        if (!response.ok) throw new LayerZeroApiError("http", response.status);
        const declared = response.headers.get("content-length");
        if (declared && parseInt(declared, 10) > 4_000_000) throw new LayerZeroApiError("schema");
        const body = await response.text();
        assertApi(body.length <= 4_000_000);
        try { return JSON.parse(body) as unknown; } catch { throw new LayerZeroApiError("schema"); }
      }
    } catch (error) {
      if (timedOut) throw new LayerZeroApiError("timeout");
      if (signal?.aborted) throw new LayerZeroApiError("aborted");
      if (error instanceof LayerZeroApiError) throw error;
      throw new LayerZeroApiError("transport");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  };
}
