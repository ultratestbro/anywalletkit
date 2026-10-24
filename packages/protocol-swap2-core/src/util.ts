/** Shared CAIP-2 helpers. Contribution packages never read deployment env. */
export function namespace(chain: string): string {
  return chain.split(":")[0] ?? "";
}
export function isEvm(chain: string): boolean {
  return namespace(chain) === "eip155";
}
export function evmRef(chain: string): number {
  return Number(chain.split(":")[1] ?? "0");
}

/**
 * `AbortSignal.timeout`, portably: Hermes (React Native) ships AbortController
 * but not the static helpers, and the unguarded call threw
 * "AbortSignal.timeout is not a function" on every remote execution — which
 * the auction then read as "no route". Falls back to a manual controller.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const native = (AbortSignal as unknown as {timeout?: (ms: number) => AbortSignal}).timeout;
  if (typeof native === "function") return native.call(AbortSignal, ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

/** `AbortSignal.any`, portably (see timeoutSignal). */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const native = (AbortSignal as unknown as {any?: (s: readonly AbortSignal[]) => AbortSignal}).any;
  if (typeof native === "function") return native.call(AbortSignal, signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(), {once: true});
  }
  return ctrl.signal;
}

/**
 * Remove URLs from text that may travel to a client (a refusal reason, a build error):
 * transport errors carry the endpoint — and with a keyed RPC (QuickNode, Alchemy,
 * Infura…) the key sits in its path (scan 2026-10-23 F8).
 */
export function redactUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>");
}
