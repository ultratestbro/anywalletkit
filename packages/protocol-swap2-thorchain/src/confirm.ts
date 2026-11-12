/**
 * What a confirming THORNode is asked, and how its answers are read (the second-node check of scan 2026-10-27
 * modules, F15). Shapes follow the THORNode OpenAPI (`LastBlockResponse`, `InboundAddressesResponse`,
 * `VaultsResponse`, `MimirResponse`); every reader returns null on anything else, so a node that answers in another
 * shape is skipped, never trusted.
 */

/**
 * The only reads sent to a confirming node: GET, these fixed paths, no query string, no body. A proxy in front of a
 * node may pass exactly these and refuse everything else. `lastblock` and `inbound_addresses` go to every node;
 * `vaults/asgard` and `mimir` only when the node's current inbound vault is not the one the quote names.
 */
export const THORNODE_CONFIRM_PATHS = Object.freeze({
  lastblock: "/thorchain/lastblock",
  inboundAddresses: "/thorchain/inbound_addresses",
  asgardVaults: "/thorchain/vaults/asgard",
  mimir: "/thorchain/mimir",
} as const);

/**
 * A signal that aborts after `ms` or when `outer` aborts, and `clear()` that drops the timer and the listener and
 * aborts whatever read of that node is still running (a sibling of one that failed). Built from AbortController +
 * setTimeout (no AbortSignal.timeout / AbortSignal.any: Hermes lacks them).
 */
export function nodeDeadline(ms: number, outer?: AbortSignal): {signal: AbortSignal; clear(): void} {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(0, ms));
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener("abort", onAbort);
  }
  return {
    signal: ctrl.signal,
    clear() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
      if (!ctrl.signal.aborted) ctrl.abort();
    },
  };
}

/** True when `actual` (a Response's `url`) is `expected` itself: no redirect elsewhere, no query, no fragment. */
export function sameRequestUrl(actual: unknown, expected: string): boolean {
  if (actual === undefined || actual === null || actual === "") return true; // runtimes that do not report it
  if (typeof actual !== "string") return false;
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    return a.origin === e.origin && a.pathname === e.pathname && a.search === "" && a.hash === "";
  } catch {
    return false;
  }
}

/** An int64 JSON field: a number, or (proto3 JSON) a decimal string. */
function int64(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
  if (typeof v === "string" && /^-?\d{1,15}$/.test(v)) return Number(v);
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** THORChain's own block height from `GET /thorchain/lastblock` (the `thorchain` field of every entry), or null. */
export function lastblockHeight(body: unknown): number | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  let height = -1;
  for (const entry of body) {
    if (!isObject(entry)) return null;
    const h = int64(entry.thorchain);
    if (h === null || h < 0) return null;
    if (h > height) height = h;
  }
  return height;
}

export interface AsgardVaultView {
  pubKey: string;
  status: string;
  addresses: readonly {chain: string; address: string}[];
}

/** `GET /thorchain/vaults/asgard`: each vault's pub key, status and per-chain addresses, or null for another shape. */
export function asgardVaults(body: unknown): AsgardVaultView[] | null {
  if (!Array.isArray(body)) return null;
  const out: AsgardVaultView[] = [];
  for (const v of body) {
    if (!isObject(v)) return null;
    if (typeof v.status !== "string" || typeof v.pub_key !== "string" || !/^thorpub1[0-9a-z]{20,}$/.test(v.pub_key)) return null;
    if (v.type !== undefined && v.type !== "AsgardVault") return null;
    if (!Array.isArray(v.addresses)) return null;
    const addresses: {chain: string; address: string}[] = [];
    for (const a of v.addresses) {
      if (!isObject(a) || typeof a.chain !== "string" || typeof a.address !== "string") return null;
      addresses.push({chain: a.chain, address: a.address});
    }
    out.push({pubKey: v.pub_key, status: v.status, addresses});
  }
  return out;
}

export type VaultFlag = "compromised" | "insolvent";

/**
 * `GET /thorchain/mimir` read for one vault: THORNode drops a vault from inbound election while
 * `CompromisedVault-<pubkey>` or any `SolvencyHaltVault-<pubkey>-<chain>` is above zero, and no-ops an inbound to a
 * compromised vault (funds are not credited). Returns a lookup, or null when the answer is not a mimir map.
 */
export function mimirFlags(body: unknown): ((pubKey: string) => VaultFlag | null | "malformed") | null {
  if (!isObject(body) || Object.keys(body).length === 0) return null;
  const keys = Object.keys(body).map((k) => [k.toUpperCase(), body[k]] as const);
  return (pubKey: string) => {
    const pub = pubKey.toUpperCase();
    const compromisedKey = `COMPROMISEDVAULT-${pub}`;
    const insolventPrefix = `SOLVENCYHALTVAULT-${pub}-`;
    let flag: VaultFlag | null = null;
    for (const [key, value] of keys) {
      const kind: VaultFlag | null = key === compromisedKey ? "compromised" : key.startsWith(insolventPrefix) ? "insolvent" : null;
      if (!kind) continue;
      const n = int64(value);
      if (n === null) return "malformed";
      if (n > 0 && flag !== "compromised") flag = kind;
    }
    return flag;
  };
}
