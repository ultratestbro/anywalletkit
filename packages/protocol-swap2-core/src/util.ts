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

/** Longest URL scheme taken out (`https`, `wss`, `git+ssh`…): a letter and up to 31 of `[A-Za-z0-9+.-]`. */
const SCHEME_MAX = 32;
const isLetter = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
const isSchemeChar = (c: number): boolean => isLetter(c) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46;
/** What ends a URL in text: `\s` as regexes define it, and `"` `'` `<` `>`. */
const endsUrl = (c: number): boolean =>
  c === 34 || c === 39 || c === 60 || c === 62 || (c >= 9 && c <= 13) || c === 32 || c === 0xa0 || c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;

/**
 * Remove URLs from text that may travel to a client (a refusal reason, a build error):
 * transport errors carry the endpoint — and with a keyed RPC (QuickNode, Alchemy,
 * Infura…) the key sits in its path (scan 2026-10-23 F8). What `/[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi`
 * would replace, found from each `://` instead of tried at every position: linear in the length of
 * `text` whatever an API or a client puts in it ("a.a.a…" made the regex this replaced quadratic;
 * scan 2026-10-27 modules, F34). A URL glued to a word loses its last 32 scheme characters and the rest.
 */
export function redactUrls(text: string): string {
  let out = "";
  let done = 0; // text[0, done) is in `out`
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", at + 3)) {
    let start = at;
    while (start > done && at - start < SCHEME_MAX && isSchemeChar(text.charCodeAt(start - 1))) start--;
    while (start < at && !isLetter(text.charCodeAt(start))) start++;
    if (start === at) continue; // no scheme: not a URL (and its tail is not scanned, so "://://…" stays linear)
    let end = at + 3;
    while (end < text.length && !endsUrl(text.charCodeAt(end))) end++;
    if (end === at + 3) continue; // nothing after "://"
    out += `${text.slice(done, start)}<url>`;
    done = end;
    at = end - 3;
  }
  return done === 0 ? text : out + text.slice(done);
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
