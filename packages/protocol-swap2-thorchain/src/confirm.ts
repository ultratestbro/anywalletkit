/**
 * What a confirming THORNode is asked, how its answers are read, and the rule that decides whether it confirms the
 * vault a quote (or a remote build) pays (the second-node check of scan 2026-10-27 modules, F15). Shapes follow the
 * THORNode OpenAPI (`LastBlockResponse`, `InboundAddressesResponse`, `VaultsResponse`, `MimirResponse`); every reader
 * returns null on anything else, so a node that answers in another shape is skipped, never trusted. The provider's
 * confirming nodes and `thorchainPins().verifyBuild` on the device apply the same rule ({@link vaultVerdict}).
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
 * Blocks a confirming node may trail the reference height before it is skipped for the next one. Public nodes
 * reachable from a browser ran ~25–28 blocks behind the Liquify gateway on 2026-11-12.
 */
export const DEFAULT_CONFIRM_MAX_LAG_BLOCKS = 50;
/** Time one confirming node gets for all of its reads. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 2_500;
/** The smallest per-node time: `confirmTimeoutMs` may not be lower, and no node is asked with less budget left. */
export const MIN_CONFIRM_TIMEOUT_MS = 100;
/** The largest `confirmTimeoutMs` (and the provider's confirmation budget). */
export const MAX_CONFIRM_TIMEOUT_MS = 8_000;

/** Validated `confirmMaxLagBlocks` / `confirmTimeoutMs`, defaults filled in; throws on anything else. */
export function confirmOptions(o: {confirmMaxLagBlocks?: number; confirmTimeoutMs?: number}): {maxLagBlocks: number; timeoutMs: number} {
  const maxLagBlocks = o.confirmMaxLagBlocks ?? DEFAULT_CONFIRM_MAX_LAG_BLOCKS;
  if (!Number.isInteger(maxLagBlocks) || maxLagBlocks < 0 || maxLagBlocks > 100_000) {
    throw new Error("thorchain: confirmMaxLagBlocks must be an integer between 0 and 100000");
  }
  const timeoutMs = o.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_CONFIRM_TIMEOUT_MS || timeoutMs > MAX_CONFIRM_TIMEOUT_MS) {
    throw new Error(`thorchain: confirmTimeoutMs must be an integer between ${MIN_CONFIRM_TIMEOUT_MS} and ${MAX_CONFIRM_TIMEOUT_MS}`);
  }
  return {maxLagBlocks, timeoutMs};
}

/**
 * A host-level failure (unreachable, gateway error, rate-limited, blocked, redirected, another shape): the next host
 * may answer. Anything else the node says — including a 4xx business rejection such as "no pool" — is an answer, not
 * a reason to shop the same question to another node.
 */
export class HostUnavailable extends Error {
  constructor(host: string, reason: string) {
    super(`thorchain: ${host} unavailable (${reason})`);
  }
}

export interface InboundAddress {
  chain?: string;
  address?: string;
  router?: string;
  halted?: boolean;
  global_trading_paused?: boolean;
  chain_trading_paused?: boolean;
  /** 1e8 source units; inbounds at or below it are IGNORED by THORChain. */
  dust_threshold?: string;
}

/** No entry for the chain, or the chain halted / trading paused. */
export function paused(entry: InboundAddress | undefined): boolean {
  return !entry || entry.halted === true || entry.global_trading_paused === true || entry.chain_trading_paused === true;
}

/** Same address: EVM (`0x…`) case-insensitively, every other chain exactly. */
export function sameTarget(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.startsWith("0x") || b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

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

/**
 * One read for the vault check (THORNODE_CONFIRM_PATHS): GET on a fixed path, no query string, no `cache` option —
 * React Native's fetch turns `cache: "no-store"` into a `?_=<time>` query, which a pass-through proxy refuses; THORNode
 * answers carry no cache validators, so nothing is reused. A redirect (`redirect: "error"`, and by `res.url` where a
 * runtime follows redirects itself, as React Native's fetch does), a non-2xx status or a body that is not JSON is a
 * host failure (the next node is asked); `outer` aborting is the caller giving up and is rethrown as is.
 */
export async function nodeRead(host: string, path: string, clientId: string, signal: AbortSignal, outer?: AbortSignal): Promise<unknown> {
  const url = `${host}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {method: "GET", headers: {accept: "application/json", "x-client-id": clientId}, redirect: "error", signal});
  } catch (error) {
    if (outer?.aborted) throw error;
    throw new HostUnavailable(host, error instanceof Error ? error.message : "fetch failed");
  }
  if (res.redirected === true || !sameRequestUrl(res.url, url)) throw new HostUnavailable(host, `${path} redirected`);
  if (!res.ok) throw new HostUnavailable(host, `${path} HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (error) {
    if (outer?.aborted) throw error;
    throw new HostUnavailable(host, `${path} is not JSON`);
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

/** What a node is asked to confirm. Chains in THORChain notation (`ETH`, `BASE`, `TRON`, `BTC`…). */
export interface VaultClaim {
  /** The source chain: its inbound entry carries the vault (and router) and must be open. */
  chain: string;
  /** The destination chain, which must be open too; omitted when only the source is checked. */
  destChain?: string;
  /** The vault the funds go to (the router call's `vault`, or the deposit's recipient). */
  vault: string;
  /** EVM: the router the transaction calls, which must be the node's router for the chain. */
  router?: string;
}

/** A node's answer to a {@link VaultClaim}. */
export type VaultVerdict =
  | {ok: true}
  | {ok: false; why: "halted"; chain: string}
  | {ok: false; why: "another-vault"}
  | {ok: false; why: "not-active"; status: string}
  | {ok: false; why: "flagged"; flag: VaultFlag}
  | {ok: false; why: "another-router"};

/** A node's THORChain height (`lastblock`) and its raw `inbound_addresses` answer, read in parallel. */
export async function nodeHead(host: string, read: (path: string) => Promise<unknown>): Promise<{height: number; inbound: unknown}> {
  const [lastblock, inbound] = await Promise.all([read(THORNODE_CONFIRM_PATHS.lastblock), read(THORNODE_CONFIRM_PATHS.inboundAddresses)]);
  const height = lastblockHeight(lastblock);
  if (height === null) throw new HostUnavailable(host, "lastblock is not a THORNode lastblock list");
  return {height, inbound};
}

/**
 * One node's verdict on the vault (and router) a quote or a build names. The vault must be the node's current inbound
 * address for the source chain, or — the inbound rotates among the active vaults every few minutes, and a node a few
 * blocks behind still names the previous one — that chain's address of a vault the node lists as ActiveVault in
 * `/thorchain/vaults/asgard` that its mimir does not flag compromised or insolvent (THORNode leaves those out of
 * inbound election). A RetiringVault, or any other status, never confirms. Both chains must be open, and on EVM the
 * node's router must be the claim's. `vaults/asgard` and `mimir` are read only when the current inbound differs.
 * Throws HostUnavailable when the node answers in another shape.
 */
export async function vaultVerdict(host: string, read: (path: string) => Promise<unknown>, inbound: unknown, claim: VaultClaim): Promise<VaultVerdict> {
  if (!Array.isArray(inbound)) throw new HostUnavailable(host, "inbound_addresses is not a list");
  const entries = inbound as (InboundAddress | null)[];
  const entry = entries.find((e) => e?.chain === claim.chain) ?? undefined;
  if (paused(entry)) return {ok: false, why: "halted", chain: claim.chain};
  if (claim.destChain !== undefined && paused(entries.find((e) => e?.chain === claim.destChain) ?? undefined)) {
    return {ok: false, why: "halted", chain: claim.destChain};
  }
  if (!sameTarget(entry?.address, claim.vault)) {
    const [asgardBody, mimirBody] = await Promise.all([read(THORNODE_CONFIRM_PATHS.asgardVaults), read(THORNODE_CONFIRM_PATHS.mimir)]);
    const vaults = asgardVaults(asgardBody);
    if (!vaults) throw new HostUnavailable(host, "vaults/asgard is not a THORNode vault list");
    const flags = mimirFlags(mimirBody);
    if (!flags) throw new HostUnavailable(host, "mimir is not a THORNode mimir map");
    const holders = vaults.filter((v) => v.addresses.some((a) => a.chain === claim.chain && sameTarget(a.address, claim.vault)));
    const active = holders.find((v) => v.status === "ActiveVault");
    if (!active) {
      if (!holders.length) return {ok: false, why: "another-vault"};
      return {ok: false, why: "not-active", status: /^[A-Za-z]{1,32}$/.test(holders[0]!.status) ? holders[0]!.status : "an unknown status"};
    }
    const flag = flags(active.pubKey);
    if (flag === "malformed") throw new HostUnavailable(host, "mimir holds a non-integer vault flag");
    if (flag) return {ok: false, why: "flagged", flag};
  }
  if (claim.router !== undefined && !sameTarget(entry?.router, claim.router)) return {ok: false, why: "another-router"};
  return {ok: true};
}
