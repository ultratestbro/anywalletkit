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
 * The texts nodes answer a call at a block they cannot serve with (read live on the swap modules' chains, 2026-11-28):
 * not there yet — a node behind a load balancer that trails the chain: geth, op-geth, Erigon, Bor, Nitro, Monad "header
 * not found"; reth, op-reth, Avalanche "block not found"; Monad "Block requested not found"; zkSync "Block with such an
 * ID doesn't exist yet"; Nitro "unsupported block number"; Mantle "requested block is above the latest consensus block";
 * X Layer, Celo "block is out of range"; "unknown block", "… in the future" — or no longer kept (a block past a
 * non-archive node's pruning: geth "missing trie node", Nitro "historical state … is not available", Nethermind "No
 * state available for block …", zkSync "Unknown state. First available state is …", reth "… is pruned", publicnode
 * "Archive requests require a personal token").
 */
const BLOCK_UNAVAILABLE_TEXT = /header not found|unknown block|block(?: [#\w]+)? (?:is )?not (?:found|available)|no such block|could not be found|(?:does not|doesn'?t) exist yet|unsupported block number|block(?: number)? (?:is )?out of range|missing trie node|\bpruned\b|historical state|no state (?:is )?available|state (?:is )?(?:not available|unavailable)|unknown state|first available state|archive (?:node|request|data|state)|in the future|future block|(?:greater|later|higher) than (?:the )?(?:latest|current|head|chain head)|(?:above|beyond|after) (?:the )?(?:latest|current|head|last accepted)/i;

/**
 * The EVM ran the call and it stopped: geth's and reth's code 3 ("execution reverted"), Nethermind's -32015 ("VM
 * execution error"), or a message that says it reverted, hit an invalid opcode or ran out of gas. That is the contract's
 * answer whatever its reason string says — "execution reverted: oracle timestamp in the future" is a revert, not a node
 * without the block (review 2026-11-28 #6). No node answered a block it lacks so (read live, 2026-11-28).
 */
const EXECUTION_CODES: ReadonlySet<number> = new Set([3, -32015]);
const EXECUTION_TEXT = /revert|invalid opcode|out of gas|vm execution error/i;

/**
 * True when a node's error (its JSON-RPC error object, or the text) says it cannot serve the block the call named —
 * it does not have that block yet, or no longer keeps its state. A provider pinned to `QuoteParams.blockNumber` tries
 * the next endpoint on it and then refuses as `stale_node` naming the block — never answers from "latest" instead.
 * Never for an execution error (code 3, -32015, or a revert's text), whatever its message goes on to say: a revert
 * reason a contract chose ("… in the future", "… could not be found") is the call's answer, not the node's.
 */
export function nodeLacksBlock(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as {code?: unknown}).code : undefined;
  if (typeof code === "number" && EXECUTION_CODES.has(code)) return false;
  const text = typeof error === "string" ? error : error && typeof error === "object" ? (error as {message?: unknown}).message : undefined;
  if (typeof text !== "string") return false;
  const head = text.slice(0, 2_048);
  return !EXECUTION_TEXT.test(head) && BLOCK_UNAVAILABLE_TEXT.test(head);
}

/**
 * The node's message when an HTTP error response's body (`text`) is a JSON-RPC error — alone or in a batch — saying it
 * cannot serve the block a call named ({@link nodeLacksBlock}); else undefined. Some endpoints answer so with an error
 * status instead of 200: X Layer and Celo 400 "block is out of range" for a block they do not have yet, publicnode 403
 * and zkSync's dRPC 400 for state past their pruning.
 */
export function blockLackedInBody(text: string): string | undefined {
  if (text.length > 65_536) return undefined;
  let body: unknown;
  try { body = JSON.parse(text); } catch { return undefined; }
  for (const item of Array.isArray(body) ? body : [body]) {
    const error = item && typeof item === "object" ? (item as {error?: unknown}).error : undefined;
    if (nodeLacksBlock(error)) return String((error as {message: string}).message).slice(0, 200);
  }
  return undefined;
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

export {PERMIT2_ADDRESS, PERMIT2_MAX_DEADLINE_SECONDS, PERMIT2_TRANSFER_TYPES, appendPermit2Signature, permit2TransferJson, readPermit2Transfer, type Permit2Transfer, type Permit2TransferExpectation} from "./permit2.js";
