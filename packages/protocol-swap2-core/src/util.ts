import {resolveAsset, type CcAsset} from "@anywalletkit/swap2-assets";
import type {QuoteParams} from "./types.js";
/** Shared CAIP-2 helpers. Contribution packages never read deployment env. */
export function namespace(chain: string): string {
  return chain.split(":")[0] ?? "";
}
/** True for an `eip155:` chain id. */
export function isEvm(chain: string): boolean {
  return namespace(chain) === "eip155";
}
/** Numeric chain id of an `eip155:<id>` CAIP-2 id. */
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

/**
 * The source asset a provider is asked to sell: the catalog's entry for `params.sourceToken`, or —
 * only when the engine sent `sourceDecimals` (an unlisted token the user added) — an unlisted asset
 * named by its contract / mint. Providers that can trade any token use this instead of the catalog
 * lookup; the others keep refusing what the catalog does not list.
 */
export function sourceAssetOf(params: Pick<QuoteParams, "sourceChain" | "sourceToken" | "sourceDecimals">): CcAsset | undefined {
  const decimals = params.sourceDecimals;
  return resolveAsset(params.sourceChain, params.sourceToken, decimals === undefined ? {} : {allowUnlisted: true, decimals});
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Standard or URL-safe base64 → bytes, without Buffer or atob (Hermes); null for anything else. */
export function base64Bytes(text: string): Uint8Array | null {
  const s = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0, acc = 0, n = 0;
  for (const ch of s) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, n);
}

/** CRC16-XMODEM, the checksum of a user-friendly TON address. */
function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/**
 * A TON address in raw form (`<workchain>:<64 hex>`, lowercase) from a raw string, a user-friendly one (bounceable or
 * not, checksum verified), or an address object (`toRawString()` / `workChain` + `hash`); null for anything else. Two
 * spellings of one address compare equal in this form.
 */
export function tonRawAddress(address: unknown): string | null {
  if (address && typeof address === "object") {
    const o = address as {toRawString?: () => string; workChain?: unknown; hash?: unknown};
    if (typeof o.toRawString === "function") { try { return tonRawAddress(o.toRawString()); } catch { return null; } }
    if (typeof o.workChain === "number" && o.hash instanceof Uint8Array && o.hash.length === 32) {
      return `${o.workChain}:${Array.from(o.hash, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
    return null;
  }
  if (typeof address !== "string") return null;
  const raw = /^(-?[0-9]{1,3}):([0-9a-fA-F]{64})$/.exec(address.trim());
  if (raw) return `${Number(raw[1])}:${raw[2]!.toLowerCase()}`;
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(address.trim())) return null;
  const bytes = base64Bytes(address.trim());
  if (!bytes || bytes.length !== 36 || crc16(bytes.subarray(0, 34)) !== ((bytes[34]! << 8) | bytes[35]!)) return null;
  const wc = bytes[1] === 0xff ? -1 : bytes[1]!;
  return `${wc}:${Array.from(bytes.subarray(2, 34), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
