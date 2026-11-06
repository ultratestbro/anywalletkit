/** `curve:<chainId>:<16 hex>`, and on the wire of a swap2 server `~<32 hex>` (its intent token) after it. */
const INTENT_ID = /^curve:([1-9][0-9]{0,15}):[0-9a-f]{16}(?:~[0-9a-f]{32})?$/;

/** A fresh Curve intent id for a quote on `chainId`: one per quote, so a remote stub never checks a build against another request. */
export function mintCurveIntentId(chainId: number): string {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `curve:${chainId}:${Array.from(nonce, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The chain a Curve intent id names (its on-chain checks and receipt tracking run there), or null. */
export function curveIntentChain(intentId: unknown): number | null {
  const m = typeof intentId === "string" ? INTENT_ID.exec(intentId) : null;
  const id = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(id) ? id : null;
}
