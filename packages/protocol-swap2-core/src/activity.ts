/**
 * Shared `describeActivity` plumbing for the swap2 provider modules.
 *
 * A provider recognizes one of its own transactions offline (contract called +
 * 4-byte selector, or a known counterparty on non-EVM chains) and this file
 * turns the chain-normalized `ChainTx` into the wallet-facing `ActivityItem`:
 * net asset movement for the owner's addresses, symbols / decimals from the
 * transfers themselves or the swap2-assets catalog, and a "Swapped X → Y" /
 * "Bridged X" / "Received X" title. Pure and synchronous, like the hook itself.
 */
import {
  activityBase,
  netTransfers,
  splitNet,
  type ActivityAsset,
  type ActivityItem,
  type ActivityKind,
  type ChainTx,
  type DescribeActivityContext,
} from "@forgewallet/core";
import {ccAssetByToken, ccChain} from "@forgewallet/swap2-assets";

/** The contract a transaction invoked (EVM `to`, Solana program, TON destination), lowercase for EVM. */
export function calledContract(tx: ChainTx): string | null {
  const to = tx.call?.to ?? tx.to;
  if (!to) return null;
  return to.startsWith("0x") ? to.toLowerCase() : to;
}

/** 4-byte selector of an EVM call (`0x`-prefixed, lowercase), from `call.selector` or the calldata. */
export function callSelector(tx: ChainTx): string | undefined {
  const explicit = tx.call?.selector;
  if (explicit && /^0x[0-9a-fA-F]{8}$/.test(explicit)) return explicit.toLowerCase();
  const data = tx.call?.data;
  if (data && /^0x[0-9a-fA-F]{8}/.test(data)) return data.slice(0, 10).toLowerCase();
  return undefined;
}

/** Does `tx` call `contract` (case-insensitive for EVM)? */
export function callsContract(tx: ChainTx, contract: string): boolean {
  const to = calledContract(tx);
  if (!to) return false;
  return to.startsWith("0x") ? to === contract.toLowerCase() : to === contract;
}

/** Does `tx` call one of `contracts` with one of `selectors` (any selector when the set is empty)? */
export function matchesCall(tx: ChainTx, contracts: Iterable<string>, selectors?: Iterable<string>): boolean {
  const to = calledContract(tx);
  if (!to) return false;
  let hit = false;
  for (const c of contracts) {
    if ((c.startsWith("0x") ? c.toLowerCase() : c) === to) {
      hit = true;
      break;
    }
  }
  if (!hit) return false;
  if (!selectors) return true;
  const want = new Set<string>();
  for (const s of selectors) want.add(s.toLowerCase());
  if (want.size === 0) return true;
  const sel = callSelector(tx);
  return sel !== undefined && want.has(sel);
}

/** Human label of a chain for subtitles ("Base", "Ethereum"), falling back to the CAIP-2 id. */
export function chainLabel(caip2: string): string {
  return ccChain(caip2)?.label ?? caip2;
}

/** `0x1234…abcd` for an address the catalog does not name. */
export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/**
 * Symbol / decimals per token: what the transfers already carry first, then the
 * swap2-assets catalog for the chain (native asset = `token === null`).
 */
export function assetMetaFor(tx: ChainTx): (token: string | null) => Partial<ActivityAsset> | undefined {
  const fromTransfers = new Map<string | null, Partial<ActivityAsset>>();
  for (const t of tx.transfers) {
    const key = t.token === null ? null : t.token.startsWith("0x") ? t.token.toLowerCase() : t.token;
    if (fromTransfers.has(key)) continue;
    const meta: Partial<ActivityAsset> = {};
    if (t.symbol !== undefined) meta.symbol = t.symbol;
    if (t.decimals !== undefined) meta.decimals = t.decimals;
    if (meta.symbol !== undefined || meta.decimals !== undefined) fromTransfers.set(key, meta);
  }
  return (token) => {
    const key = token === null ? null : token.startsWith("0x") ? token.toLowerCase() : token;
    const known = fromTransfers.get(key);
    if (known?.symbol !== undefined && known.decimals !== undefined) return known;
    const cat = ccAssetByToken(tx.chain, token ?? "");
    if (!cat) return known;
    const meta: Partial<ActivityAsset> = {symbol: known?.symbol ?? cat.symbol, decimals: known?.decimals ?? cat.decimals};
    return meta;
  };
}

/** Symbol for a title: the asset's symbol, the chain's native coin, or a shortened address. */
export function assetLabel(tx: ChainTx, a: ActivityAsset): string {
  if (a.symbol) return a.symbol;
  if (a.token === null) return ccAssetByToken(tx.chain, "")?.symbol ?? "native";
  return shortAddress(a.token);
}

/** Net movement for the owner, split into what left and what arrived, with symbols. */
export function ownerAssets(tx: ChainTx, ctx: DescribeActivityContext): {assetsIn: ActivityAsset[]; assetsOut: ActivityAsset[]} {
  return splitNet(netTransfers(tx, ctx.own), assetMetaFor(tx));
}

/** The largest-looking leg for a title: first asset, preferring one with a symbol. */
function lead(tx: ChainTx, assets: ActivityAsset[]): string | undefined {
  const a = assets.find((x) => x.symbol) ?? assets[0];
  return a ? assetLabel(tx, a) : undefined;
}

export interface SwapActivityOptions {
  /** Registry module name (`module.json` → `name`). */
  protocol: string;
  /** Venue label for the subtitle, e.g. "LI.FI", "Uniswap v3 · Base". */
  subtitle?: string;
  /**
   * What the transaction is. `swap` / `bridge` get the automatic title
   * ("Swapped A → B", "Bridged A", "Received A"); `auto` picks `swap` when both
   * legs netted on this chain and `bridge` otherwise.
   */
  kind: ActivityKind | "auto";
  /** Override the computed title. */
  title?: string;
  /** Override the counterparty (default: the contract called). */
  counterparty?: string;
  /** Verb for a one-legged outbound item (default "Bridged"). */
  outVerb?: string;
  /** Suffix for a one-legged inbound item, e.g. "via CCTP" → "Received USDC via CCTP". */
  inSuffix?: string;
}

/**
 * Build the item once the caller has decided the transaction is this module's.
 * Returns null only when the owner moved nothing and no title was given — a
 * recognized call that touched none of the owner's balances is not activity.
 */
export function describeSwapLike(tx: ChainTx, ctx: DescribeActivityContext, o: SwapActivityOptions): ActivityItem | null {
  const {assetsIn, assetsOut} = ownerAssets(tx, ctx);
  const inLabel = lead(tx, assetsIn);
  const outLabel = lead(tx, assetsOut);
  let kind: ActivityKind;
  if (o.kind === "auto") kind = assetsIn.length > 0 && assetsOut.length > 0 ? "swap" : "bridge";
  else kind = o.kind;
  let title = o.title;
  if (title === undefined) {
    const received = inLabel ? `Received ${inLabel}${o.inSuffix ? ` ${o.inSuffix}` : ""}` : undefined;
    if (kind === "bridge") {
      // A bridge leg names what left; an inbound dust refund (gas rebate, surplus) is not the destination asset.
      if (outLabel) title = `${o.outVerb ?? "Bridged"} ${outLabel}`;
      else if (received) title = received;
    } else if (outLabel && inLabel) title = `Swapped ${outLabel} → ${inLabel}`;
    else if (outLabel) title = `${o.outVerb ?? "Swapped"} ${outLabel}`;
    else if (received) title = received;
    if (title === undefined) {
      if (tx.status === "failed") title = `Failed ${kind}`;
      else return null;
    }
  }
  const counterparty = o.counterparty ?? tx.call?.to ?? tx.to ?? undefined;
  const extra: Partial<ActivityItem> = {protocol: o.protocol, assetsIn, assetsOut};
  if (o.subtitle !== undefined) extra.subtitle = o.subtitle;
  if (counterparty !== undefined) extra.counterparty = counterparty;
  return activityBase(tx, kind, title, extra);
}
