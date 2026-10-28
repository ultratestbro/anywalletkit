import {thorchain as thorCfg} from "./config.js";
import {describeThorchainActivity} from "./activity.js";
import {decodeFunctionData, encodeFunctionData} from "viem";
import {timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import {ccAsset, ccAssetByToken} from "@anywalletkit/swap2-assets";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {bigintToNumber} from "@anywalletkit/core";

/**
 * THORChain — native L1 swaps via asgard vaults (no wrapping). Ported from
 * a production THORChain integration. Scope here is **EVM sources first**: the user
 * deposits on an EVM chain (Ethereum/Base/BSC/Avalanche) into the THORChain router with
 * `depositWithExpiry(vault, asset, amount, memo, expiry)`; THORChain settles the
 * swap and delivers ETH/stables to our mainnet vault. **Tron** (opt-in,
 * `tronSource`) executes as a native TRX send / TRC-20 transfer to the inbound
 * vault with the memo in `raw_data.data` — bifrost reads that field for both
 * TransferContract and TriggerSmartContract. BTC/Cosmos/Solana sources are not
 * routed yet (no memo-capable send surface).
 *
 * Safety: the MEMO and inbound vault come verbatim from the quote — we never
 * hand-build them (a wrong memo makes funds unrecoverable). The quote
 * embeds an on-chain LIM, so a bad-price swap refunds instead of filling:
 * `liquidity_tolerance_bps` when the caller passes a slippage (LIM = expected
 * output after fees × (1 − slippage)), `tolerance_bps` otherwise.
 *
 * Hosts (re-verified 2026-10-28): two public THORNodes of different operators —
 * Liquify's public GATEWAY (50k req/day per IP; x-client-id identifies us for a
 * bump) and the IBS team's node. Nine Realms retired its hosts, the Liquify
 * vanity hostname serves an expired certificate and thornode.thorchain.network
 * no longer resolves. Hosts are tried in order for the quote, and a quote is
 * bound to an inbound snapshot from the SAME host; the source vault and router
 * must then be confirmed by a SECOND host (scan 2026-10-27 modules, F15): one
 * node's answer is not an authority over where the funds go. The list is an
 * explicit constructor option (`nodeUrl`, one or many, plus `confirmNodeUrl`);
 * this package never reads deployment environment values.
 */

const HOSTS = [
  "https://gateway.liquify.com/chain/thorchain_api",
  "https://thorchain.ibs.team/api",
];

/**
 * THORChain's EVM routers (`depositWithExpiry`), the only contracts an EVM-source swap may call and approve (scan
 * 2026-10-27 modules, F15). Reported identically on 2026-10-28 by both default nodes (two operators) and by every
 * October quote-matrix build. A router migration needs a release or `trustedRouters`; until then a quote naming
 * another router is refused, never followed.
 */
export const THORCHAIN_ROUTERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "eip155:1": Object.freeze(["0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146"]),
  "eip155:56": Object.freeze(["0xb30eC53F98ff5947EDe720D32aC2da7e52A5f56b"]),
  "eip155:43114": Object.freeze(["0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4"]),
  "eip155:8453": Object.freeze(["0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4"]),
});

const DEFAULT_CLIENT_ID = "anywalletkit";

const NATIVE = "0x0000000000000000000000000000000000000000";
const TOLERANCE_BPS = "300"; // 3% max slippage, embedded as an on-chain LIM
// Two ways to ask THORNode for the LIM:
// - `liquidity_tolerance_bps` — measured from the expected output AFTER
//   THORChain's fees (liquidity, outbound, affiliate): LIM = expected × (1 −
//   slippage), the floor every other provider quotes and validQuote enforces.
//   Used whenever the caller passes a slippage, in one request.
// - `tolerance_bps` — measured from the FEELESS spot: LIM = spot × (1 −
//   tolerance), so the room left is (tolerance − fees) and the node rejects
//   the quote outright when fees exceed it ("emit asset X less than price
//   limit Y"; 500 USDC Base → BTC at 1% paid ≈1.7%). Kept only for legacy
//   quotes without a slippage, which widen it to what the pool needs.
// Both are hard-capped: a route whose THORChain fees alone exceed the cap
// stays hidden, with a named reason.
const MAX_TOLERANCE_BPS = 500n;
/** How long a quote stays executable (bounded by the memo's own expiry). */
const QUOTE_VALIDITY_MS = 5 * 60_000;

// CAIP-2 → THORChain chain prefix. EVM chains execute via the router; TRON
// executes via a native send to the inbound vault + memo (no router).
const THOR_CHAIN: Record<string, string> = {
  "eip155:1": "ETH",
  "eip155:8453": "BASE",
  "eip155:56": "BSC",
  // 2026-09-16: AVAX.AVAX/USDC/USDT pools Available (≈$2.5M/$0.3M/$0.2M),
  // router 0x00dc61…f1d4 live in inbound_addresses; same depositWithExpiry ABI.
  // Polygon has no THORChain pool any more — deliberately absent.
  "eip155:43114": "AVAX",
  "tron:728126428": "TRON",
  "bitcoin:mainnet": "BTC",
  // 2026-08 (pools verified live via the Liquify gateway): THORChain added
  // SOL/XRP, and our catalog now carries LTC/DOGE/BCH/ATOM — destination legs
  // for the step-2 off-ramp (source stays EVM/Tron, see supportsRoute).
  "solana:mainnet": "SOL",
  "xrp:mainnet": "XRP",
  "litecoin:mainnet": "LTC",
  "doge:mainnet": "DOGE",
  "bch:mainnet": "BCH",
  "cosmos:cosmoshub-4": "GAIA",
};
const CHAIN_ID: Record<string, number> = {"eip155:1": 1, "eip155:8453": 8453, "eip155:56": 56, "eip155:43114": 43114};
const TRON_CAIP2 = "tron:728126428";
// Sources executed as a plain send to the inbound vault + memo (no router).
// Only chains whose account can attach the memo ON-CHAIN belong here; an
// unsent memo strands the deposit in the vault.
const DEPOSIT_SOURCES = new Set([TRON_CAIP2]);
const NATIVE_ASSET: Record<string, string> = {
  ETH: "ETH.ETH",
  BASE: "BASE.ETH",
  BSC: "BSC.BNB",
  AVAX: "AVAX.AVAX",
  TRON: "TRON.TRX",
  BTC: "BTC.BTC",
  SOL: "SOL.SOL",
  XRP: "XRP.XRP",
  LTC: "LTC.LTC",
  DOGE: "DOGE.DOGE",
  BCH: "BCH.BCH",
  GAIA: "GAIA.ATOM",
};

// Curated token asset notation (UPPERCASE contract, as THORChain expects).
// Pools come and go (all eight verified Available via the Liquify gateway,
// 2026-09-16); a retired pool's quote just 404s to null, so entries stay harmless.
const TOKEN_ASSET: Record<string, string> = {
  "ETH:USDC": "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
  "ETH:USDT": "ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7",
  "BASE:USDC": "BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913",
  "BSC:USDC": "BSC.USDC-0X8AC76A51CC950D9822D68B83FE1AD97B32CD580D",
  "BSC:USDT": "BSC.USDT-0X55D398326F99059FF775485246999027B3197955",
  "AVAX:USDC": "AVAX.USDC-0XB97EF9EF8734C71904D8002F8B6BC66DD9C48A6E",
  "AVAX:USDT": "AVAX.USDT-0X9702230A8EA53601F5CD2DC00FDBC13D4DF4A8C7",
  "TRON:USDT": "TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T",
};

const ROUTER_ABI = [
  {
    type: "function",
    name: "depositWithExpiry",
    stateMutability: "payable",
    inputs: [
      {name: "vault", type: "address"},
      {name: "asset", type: "address"},
      {name: "amount", type: "uint256"},
      {name: "memo", type: "string"},
      {name: "expiration", type: "uint256"},
    ],
    outputs: [],
  },
] as const;

function isEvm(caip2: string): boolean {
  return caip2.startsWith("eip155:");
}

/** THOR asset notation for a (chain, symbol) on either leg, or undefined. */
function thorAsset(caip2: string, symbol: string): string | undefined {
  const chain = THOR_CHAIN[caip2];
  if (!chain) return undefined;
  const sym = symbol.toUpperCase();
  const token = TOKEN_ASSET[`${chain}:${sym}`];
  if (token) return token;
  const native = NATIVE_ASSET[chain];
  return native && native.split(".")[1] === sym ? native : undefined;
}

/**
 * Destination asset for either direction: inbound → the vault on Ethereum, or
 * the step-2 off-ramp → any THOR-supported chain (BTC/BASE/BSC/TRON). Resolved
 * from the catalog so we get the right symbol + decimals for the target chain.
 */
function destAsset(destChain: string, destToken: string): {asset: string; decimals: number} | undefined {
  const a = ccAssetByToken(destChain, destToken);
  if (!a) return undefined;
  const asset = thorAsset(destChain, a.symbol);
  return asset ? {asset, decimals: a.decimals} : undefined;
}

interface ThorQuoteResponse {
  expected_amount_out?: string;
  inbound_address?: string;
  router?: string;
  memo?: string;
  expiry?: number;
  total_swap_seconds?: number;
  /** 1e8 source units; below this the swap is refunded minus fees. */
  recommended_min_amount_in?: string;
  error?: string;
  /** thornode simulation rejections arrive as {code, message}. */
  message?: string;
  /** THORChain's fees on this quote; `total_bps` includes liquidity, outbound and affiliate. */
  fees?: {total_bps?: number};
}

/**
 * A host-level failure (unreachable, gateway error, rate-limited, blocked):
 * the next host may answer. Anything else the node says — including a 4xx
 * business rejection such as "no pool" — is an answer, not a reason to shop
 * the same question to another node.
 */
class HostUnavailable extends Error {
  constructor(host: string, reason: string) {
    super(`thorchain: ${host} unavailable (${reason})`);
  }
}

interface HostResponse {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | unknown[] | null;
}

async function hostGet(host: string, path: string, clientId: string, signal?: AbortSignal): Promise<HostResponse> {
  let res: Response;
  try {
    res = await fetch(`${host}${path}`, {
      headers: {accept: "application/json", "x-client-id": clientId},
      cache: "no-store",
      signal: signal ?? timeoutSignal(8000),
    });
  } catch (error) {
    if (signal?.aborted) throw error; // the caller gave up — not the host's fault
    throw new HostUnavailable(host, error instanceof Error ? error.message : "fetch failed");
  }
  if (res.status >= 500 || res.status === 429 || res.status === 403) {
    throw new HostUnavailable(host, `HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as HostResponse["body"];
  return {ok: res.ok, status: res.status, body};
}

/** Per-request failover for reads whose answer is host-independent (tx status). */
async function thornodeGet(
  path: string,
  signal: AbortSignal | undefined,
  hosts: string[],
  clientId: string,
): Promise<Record<string, unknown> | null> {
  for (const host of hosts) {
    try {
      const res = await hostGet(host, path, clientId, signal);
      if (!res.ok) continue;
      return Array.isArray(res.body) ? null : res.body;
    } catch (error) {
      if (error instanceof HostUnavailable) continue;
      throw error;
    }
  }
  return null;
}

interface InboundAddress {
  chain?: string;
  address?: string;
  router?: string;
  halted?: boolean;
  global_trading_paused?: boolean;
  chain_trading_paused?: boolean;
  /** 1e8 source units; inbounds at or below it are IGNORED by THORChain. */
  dust_threshold?: string;
}

/** Fail closed on amounts THORChain would ignore (dust) or refund (below the
 *  recommended minimum). Both are quoted in 1e8 source units. */
function belowThorMinimums(amount1e8: bigint, inbound: InboundAddress | undefined, quote: ThorQuoteResponse | null): string | null {
  const dust = inbound?.dust_threshold;
  if (dust !== undefined && (!/^\d+$/.test(String(dust)) || amount1e8 <= BigInt(dust))) return "amount at or below THORChain dust threshold";
  const min = quote?.recommended_min_amount_in;
  if (min !== undefined && (!/^\d+$/.test(String(min)) || amount1e8 < BigInt(min))) return "amount below THORChain recommended minimum";
  return null;
}

/** Inbound snapshot from ONE host. Throws HostUnavailable so the caller can
 *  re-run the whole quote on the next host rather than mixing nodes. */
async function inboundAddressesOn(host: string, clientId: string): Promise<InboundAddress[]> {
  const res = await hostGet(host, "/thorchain/inbound_addresses", clientId);
  if (!res.ok || !Array.isArray(res.body)) throw new HostUnavailable(host, `inbound_addresses HTTP ${res.status}`);
  return res.body as InboundAddress[];
}

function paused(entry: InboundAddress | undefined): boolean {
  return !entry || entry.halted === true || entry.global_trading_paused === true || entry.chain_trading_paused === true;
}

function sameTarget(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.startsWith("0x") || b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function verifiedMemo(
  memo: string,
  expectedAsset: string,
  expectedDestination: string,
  expectedRefund: string,
  expectedAffiliate: string,
  expectedAffiliateBps: string,
): {limit: bigint; canonical: string} | null {
  if (memo.includes("|")) return null; // DEX-aggregator tail is a separate, unbound execution program.
  const parts = memo.split(":");
  if (parts.length !== 4 && parts.length !== 6) return null;
  const [op, asset, destination, limit, affiliate, bps] = parts;
  // Quote responses legitimately use THORChain fuzzy asset notation (`b` for
  // BTC.BTC). We never execute that untrusted spelling: after checking the
  // shape, destination/refund, limit and affiliate we rebuild a canonical memo
  // from our own route facts below.
  if (op !== "=" || !asset || !/^[A-Za-z0-9._~\-]+$/.test(asset)) return null;
  const expectedTarget = expectedRefund ? `${expectedDestination}/${expectedRefund}` : expectedDestination;
  if (!sameTarget(destination, expectedTarget)) return null;
  if (parts.length === 6) {
    if (!expectedAffiliate || affiliate !== expectedAffiliate || bps !== expectedAffiliateBps) return null;
  } else if (expectedAffiliate || expectedAffiliateBps) {
    return null;
  }
  const stream = (limit ?? "").split("/");
  // We never request streaming swaps. A provider-supplied LIM/INTERVAL/QTY
  // memo changes the floor to a per-sub-swap condition, so reject it instead
  // of presenting LIM as an atomic total guarantee.
  if (stream.length !== 1 || stream.some((v) => !/^\d+$/.test(v))) return null;
  const floor = BigInt(stream[0] ?? "0");
  if (floor <= 0n) return null;
  const canonical = `=:${expectedAsset}:${expectedTarget}:${stream.join("/")}${
    expectedAffiliate ? `:${expectedAffiliate}:${expectedAffiliateBps}` : ""
  }`;
  return {limit: floor, canonical};
}

function toThorUnitsCeil(amount: bigint, decimals: number): bigint {
  const scale = 10n ** BigInt(decimals);
  return (amount * 100_000_000n + scale - 1n) / scale;
}

/** Explicit constructor configuration; no deployment environment is read. */
export interface ThorchainProviderConfig {
  enabled?: boolean;
  affiliate?: string;
  affiliateBps?: string;
  /**
   * THORNode base URL(s), tried in order; a comma-separated string is
   * accepted for env-style configuration. Defaults to the documented public
   * hosts. Quote + inbound snapshot always come from the same host.
   */
  nodeUrl?: string | string[];
  /**
   * Nodes that confirm the source vault and router a quote names (scan 2026-10-27 modules, F15): another host must
   * report the same before a quote is used and again right before broadcast; a disagreeing or silent second source
   * refuses. Default: the other `nodeUrl` hosts, else the default public nodes. Name a node of another operator.
   */
  confirmNodeUrl?: string | string[];
  /** Routers to trust besides {@link THORCHAIN_ROUTERS}, per CAIP-2 chain (a router migration before a release). */
  trustedRouters?: Readonly<Record<string, readonly string[]>>;
  /** Allow `http:` node URLs (local development only): the vault and router a swap pays come from them. */
  allowInsecureNodeUrl?: boolean;
  /** Optional gateway identification; defaults to a neutral module name. */
  clientId?: string;
  /**
   * Opt-in Tron SOURCE execution: a native TRX send / TRC-20 transfer to the
   * inbound vault carrying the swap memo in `raw_data.data`. Ships dark: the
   * bound account MUST attach the memo on-chain (`raw_data.data`); a
   * memo-less send is unsettleable.
   */
  tronSource?: boolean;
}

/**
 * The app's side of a remote THORChain stub (scan 2026-10-27 modules, F15): `remoteProvider({name: "thorchain",
 * baseUrl, ...thorchainPins()})`. The pinned routers are the only call targets and spenders, and `verifyBuild` checks
 * the build on the client: the vault in the router call (or the Tron deposit's recipient) confirmed by two THORNodes
 * of different operators, the source asset and exact input, and the memo's asset, destination, refund and limit
 * against the app's own request. Pass the affiliate your backend's provider uses (the memo must carry exactly it).
 */
export function thorchainPins(opts: {
  nodeUrl?: string | string[];
  affiliate?: string;
  affiliateBps?: string;
  trustedRouters?: Readonly<Record<string, readonly string[]>>;
  clientId?: string;
} = {}): RemotePins & {verifyBuild(quote: Quote, tx: UnsignedTx, params?: QuoteParams): Promise<string | null>} {
  const nodes = [...new Set((Array.isArray(opts.nodeUrl) ? opts.nodeUrl : opts.nodeUrl ? opts.nodeUrl.split(",") : HOSTS).map((h) => h.trim().replace(/\/$/, "")).filter(Boolean))];
  for (const n of nodes) if (!/^https:\/\//i.test(n)) throw new Error("thorchain: thorchainPins nodeUrl must use https");
  const clientId = opts.clientId?.trim() || DEFAULT_CLIENT_ID;
  const routersFor = (chain: string): readonly string[] => [...(THORCHAIN_ROUTERS[chain] ?? []), ...(opts.trustedRouters?.[chain] ?? [])];
  return Object.freeze({
    callTargets: routersFor,
    spenders: routersFor,
    async verifyBuild(quote: Quote, tx: UnsignedTx, params?: QuoteParams): Promise<string | null> {
      if (!params) return "the request this quote answered is unknown";
      const src = ccAsset(params.sourceChain, params.sourceToken);
      const dst = destAsset(params.destChain, params.destToken);
      if (!src || !dst) return "unknown source or destination asset";
      const chainId = CHAIN_ID[params.sourceChain];
      let vault: string, memo: string, router: string | undefined;
      if (chainId) {
        if (!tx.data) return "no router calldata";
        let args: readonly unknown[] | undefined;
        try {
          const d = decodeFunctionData({abi: ROUTER_ABI, data: tx.data as `0x${string}`});
          if (d.functionName !== "depositWithExpiry") return `${d.functionName} is not depositWithExpiry`;
          args = d.args;
        } catch { return "the router calldata does not decode"; }
        if (!args || args.length !== 5) return "the router calldata does not decode";
        router = tx.to;
        if (!routersFor(params.sourceChain).some((r) => sameTarget(r, router))) return `router ${tx.to} is not pinned`;
        vault = String(args[0]);
        const asset = String(args[1]);
        if (!sameTarget(asset, src.contract ?? NATIVE)) return `the router call moves ${asset}, not the source asset`;
        if (BigInt(args[2] as bigint) !== BigInt(quote.sourceAmount)) return `the router call moves ${String(args[2])}, not the ${quote.sourceAmount} input`;
        memo = String(args[3]);
      } else {
        // A deposit source (Tron): a plain send of the input to the vault with the memo.
        if (!tx.memo || tx.value !== quote.sourceAmount) return "the deposit is not a send of the input with a memo";
        vault = tx.to;
        memo = tx.memo;
      }
      const checked = verifiedMemo(memo, dst.asset, params.destAddress, params.refundAddress ?? "", opts.affiliate ?? "", opts.affiliateBps ?? "");
      if (!checked) return `the memo does not pay ${params.destAddress} in ${dst.asset} with this app's refund and affiliate`;
      if ((checked.limit * 10n ** BigInt(dst.decimals)) / 100_000_000n < BigInt(quote.minDestAmount)) return `the memo's limit ${checked.limit} is below the quoted minimum`;
      // Two nodes of different operators must report this vault (and router), trading open.
      let agreeing = 0;
      for (const host of nodes) {
        let entries: InboundAddress[];
        try { entries = await inboundAddressesOn(host, clientId); } catch (error) { if (error instanceof HostUnavailable) continue; throw error; }
        const entry = entries.find((e) => e.chain === THOR_CHAIN[params.sourceChain]);
        if (paused(entry)) return `${THOR_CHAIN[params.sourceChain]} is halted / paused`;
        if (!sameTarget(entry?.address, vault)) return `a THORNode reports another inbound vault than ${vault}`;
        if (router !== undefined && !sameTarget(entry?.router, router)) return "a THORNode reports another router";
        if (++agreeing >= 2) return null;
      }
      return "two THORNodes could not confirm the inbound vault";
    },
  });
}

export function thorchainProvider(config: ThorchainProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const configuredHosts = (Array.isArray(config.nodeUrl) ? config.nodeUrl : (config.nodeUrl ?? "").split(","))
    .map((h) => h.trim())
    .filter(Boolean);
  const hosts = [...new Set((configuredHosts.length ? configuredHosts : HOSTS).map((h) => {
    let url: URL;
    try {
      url = new URL(h);
    } catch {
      throw new Error("thorchain: nodeUrl must be an absolute http(s) URL");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && config.allowInsecureNodeUrl === true)) {
      throw new Error("thorchain: nodeUrl must use https (allowInsecureNodeUrl for local development)");
    }
    return url.toString().replace(/\/$/, "");
  }))];
  const parseHosts = (input: string | string[] | undefined): string[] => (Array.isArray(input) ? input : (input ?? "").split(","))
    .map((h) => h.trim()).filter(Boolean).map((h) => {
      let url: URL;
      try { url = new URL(h); } catch { throw new Error("thorchain: confirmNodeUrl must be an absolute https URL"); }
      if (url.protocol !== "https:" && !(url.protocol === "http:" && config.allowInsecureNodeUrl === true)) throw new Error("thorchain: confirmNodeUrl must use https");
      return url.toString().replace(/\/$/, "");
    });
  const confirmHosts = [...new Set([...parseHosts(config.confirmNodeUrl), ...hosts, ...HOSTS])];
  const routers = new Map<string, Set<string>>();
  for (const [chain, list] of [...Object.entries(THORCHAIN_ROUTERS), ...Object.entries(config.trustedRouters ?? {})]) {
    const set = routers.get(chain) ?? new Set<string>();
    for (const r of list) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(r)) throw new Error(`thorchain: trusted router for ${chain} is not an EVM address`);
      set.add(r.toLowerCase());
    }
    routers.set(chain, set);
  }
  const pinnedRouter = (chain: string, router: string | undefined) => !!router && routers.get(chain)?.has(router.toLowerCase()) === true;
  /**
   * A second node's view of the source chain, from a host other than `quoteHost`: the vault (and router) it reports
   * must be the quote's, and trading open. The reason it fails, or null.
   */
  const confirmedElsewhere = async (quoteHost: string, chain: string, vault: string, router: string | undefined): Promise<string | null> => {
    for (const host of confirmHosts) {
      if (host === quoteHost) continue;
      let entries: InboundAddress[];
      try { entries = await inboundAddressesOn(host, clientId); } catch (error) { if (error instanceof HostUnavailable) continue; throw error; }
      const entry = entries.find((e) => e.chain === THOR_CHAIN[chain]);
      if (paused(entry)) return `${THOR_CHAIN[chain]} is halted / paused on the confirming node`;
      if (!sameTarget(entry?.address, vault)) return "a second node reports another inbound vault — refused until they agree";
      if (router !== undefined && !sameTarget(entry?.router, router)) return "a second node reports another router — refused until they agree";
      return null;
    }
    return "no second node answered to confirm the inbound vault (configure confirmNodeUrl)";
  };
  const configuredAffiliate = config.affiliate ?? "";
  const configuredAffiliateBps = config.affiliateBps ?? "";
  if (!!configuredAffiliate !== !!configuredAffiliateBps) {
    throw new Error("thorchain: affiliate and affiliateBps must be configured together");
  }
  if (configuredAffiliate && !/^[A-Za-z0-9._~-]+$/.test(configuredAffiliate)) {
    throw new Error("thorchain: affiliate contains unsupported memo characters");
  }
  if (configuredAffiliateBps && (!/^\d+$/.test(configuredAffiliateBps) || BigInt(configuredAffiliateBps) > 10_000n)) {
    throw new Error("thorchain: affiliateBps must be an integer between 0 and 10000");
  }
  const clientId = config.clientId?.trim() || DEFAULT_CLIENT_ID;
  if (!/^[\x21-\x7e]{1,128}$/.test(clientId)) throw new Error("thorchain: clientId must contain 1-128 visible ASCII characters");
  const tronSource = config.tronSource === true;
  const isDepositSource = (caip2: string): boolean => tronSource && DEPOSIT_SOURCES.has(caip2);
  return {
    name: "thorchain",
    describeActivity: describeThorchainActivity,
    enabled: () => config.enabled ?? true,

    // Capability discovery comes from the provider itself, so it can run alone
    // or inside the optional aggregator without a central capability table.
    supportsChain: (chain: string) => thorCfg.supportsChain(chain),
    supportsChainPair: (fromChain: string, toChain: string) => thorCfg.supports(fromChain, toChain),
    // Inbound: EVM/Tron source → the mainnet vault. Outbound (step-2 off-ramp):
    // EVM source (Ethereum) → any THOR-supported chain. The SOURCE must be EVM
    // (router calldata) or, when opted in, Tron (send + memo); both legs must
    // be THOR chains and differ.
    supportsRoute(from: Asset, to: Asset): boolean {
      const srcExec = isEvm(from.chain) || isDepositSource(from.chain);
      if (!(srcExec && !!THOR_CHAIN[from.chain] && !!THOR_CHAIN[to.chain] && from.chain !== to.chain)) return false;
      // Asset level too: claiming a chain pair whose assets THORChain has no
      // pool for (e.g. USDC on Solana) put the provider in every route list
      // and then answered a silent null.
      const fromAsset = thorAsset(from.chain, from.token) ?? thorAsset(from.chain, ccAssetByToken(from.chain, from.token)?.symbol ?? "");
      const toAsset = destAsset(to.chain, to.token) ?? (thorAsset(to.chain, to.token) ? {asset: thorAsset(to.chain, to.token)!} : undefined);
      return !!fromAsset && !!toAsset && fromAsset !== toAsset.asset;
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      if (!(config.enabled ?? true)) return null;
      if (params.flex) return null; // memo/LIM embed the exact amount
      const chainId = CHAIN_ID[params.sourceChain];
      // EVM sources execute via the router; opted-in deposit sources (Tron)
      // via send + memo. Anything else has no safe executor.
      if (!chainId && !isDepositSource(params.sourceChain)) return null;
      if (params.sourceChain === params.destChain) return null; // same-chain: not a swap

      const src = ccAsset(params.sourceChain, params.sourceToken);
      const fromAsset = thorAsset(params.sourceChain, params.sourceToken);
      const dst = destAsset(params.destChain, params.destToken);
      if (!src || !fromAsset || !dst || fromAsset === dst.asset) {
        params.onRefusal?.(`thorchain: no pool for ${params.sourceToken} on ${params.sourceChain} → ${params.destToken} on ${params.destChain}`);
        return null;
      }

      // THORChain amounts are universally 1e8-scaled.
      const amountIn = BigInt(params.amountIn);
      const amount1e8 = (amountIn * 100000000n) / 10n ** BigInt(src.decimals);
      if (amount1e8 <= 0n) return null;
      // THOR quotes only 1e8 units. Never send a larger high-precision source
      // amount than the amount priced by the quote (the remainder is dust the
      // memo cannot account for and may be donated to the vault).
      if (amount1e8 * 10n ** BigInt(src.decimals) !== amountIn * 100_000_000n) {
        params.onRefusal?.(`thorchain: amount has more precision than THORChain's 8 decimals — round it to 8 decimals`);
        return null;
      }

      const requestedTolerance = params.slippageBps ?? Number(TOLERANCE_BPS);
      if (!Number.isInteger(requestedTolerance) || requestedTolerance < 0 || requestedTolerance > bigintToNumber(MAX_TOLERANCE_BPS)) {
        params.onRefusal?.(`thorchain: slippage ${String(params.slippageBps)} bps is outside 0–${MAX_TOLERANCE_BPS} bps`);
        return null;
      }
      // An explicit slippage → `liquidity_tolerance_bps`. The node floors LIM in
      // 1e8 units; for a destination with more than 8 decimals that floor lands
      // a hair below expected × (1 − slippage) in base units, so ask 1 bp
      // tighter there (never looser). 0 bp cannot carry a LIM that way: such a
      // request goes out as `tolerance_bps` and the node's answer stands.
      const explicitSlippage = params.slippageBps !== undefined;
      const liquidityBps = explicitSlippage ? (dst.decimals > 8 ? requestedTolerance - 1 : requestedTolerance) : 0;
      const limitMode = liquidityBps > 0 ? "liquidity_tolerance_bps" : "tolerance_bps";
      // `tolerance_bps` → LIM from the feeless spot output; `liquidity_tolerance_bps`
      // → LIM from the expected output after fees (the node accepts only one).
      const quoteOn = async (
        host: string,
        bps: string,
        limitMode: "tolerance_bps" | "liquidity_tolerance_bps" = "tolerance_bps",
      ): Promise<ThorQuoteResponse | null> => {
        const qs = new URLSearchParams({
          from_asset: fromAsset,
          to_asset: dst.asset,
          amount: amount1e8.toString(),
          destination: params.destAddress,
          [limitMode]: bps,
          // Pin a single (non-streaming) swap. Left to itself the node picks
          // streaming for thin pools (max_streaming_quantity > 1) and then
          // simulates the LIM per sub-swap — the adaptive retry could never
          // pass on BASE.ETH / BSC stables (verified 2026-09-16). We reject
          // streaming memos anyway, so the quote must be simulated atomically.
          streaming_quantity: "1",
        });
        if (configuredAffiliate && configuredAffiliateBps) {
          qs.set("affiliate", configuredAffiliate);
          qs.set("affiliate_bps", configuredAffiliateBps);
        }
        if (params.refundAddress) qs.set("refund_address", params.refundAddress);
        const res = await hostGet(host, `/thorchain/quote/swap?${qs.toString()}`, clientId, signal);
        if (Array.isArray(res.body)) return null;
        // A 4xx carries the node's rejection body (used by the adaptive retry).
        return (res.body ?? (res.ok ? null : {error: `HTTP ${res.status}`})) as ThorQuoteResponse | null;
      };

      // Host failover: the quote AND the inbound snapshot it is bound to must
      // come from one node. If either call fails at the host level, the whole
      // pair is re-run on the next host; a node's business rejection is final.
      let q: ThorQuoteResponse | null = null;
      let checkedMemo: ReturnType<typeof verifiedMemo> = null;
      let inbounds: InboundAddress[] | null = null;
      let quoteHost = "";
      for (const host of hosts) {
        try {
          if (limitMode === "liquidity_tolerance_bps") {
            q = await quoteOn(host, String(liquidityBps), "liquidity_tolerance_bps");
            const feeBps = Number(q?.fees?.total_bps);
            if (Number.isFinite(feeBps) && feeBps > bigintToNumber(MAX_TOLERANCE_BPS)) {
              // Dust amounts: a fixed outbound fee eats the swap.
              params.onRefusal?.(`thorchain: THORChain fees ${(feeBps / 100).toFixed(2)}% — too expensive at this amount (cap ${bigintToNumber(MAX_TOLERANCE_BPS) / 100}%)`);
              return null;
            }
          } else {
            q = await quoteOn(host, String(requestedTolerance));
            // Legacy quotes without a slippage: fees > tolerance makes the node
            // reject the quote; the rejection carries the actual emit vs the
            // limit the tolerance implied. ONE retry, on the same host, widens
            // the tolerance to what the pool needs (+buffer), capped. An
            // explicit 0 bp slippage is never widened — the rejection stands.
            const rejected = (q?.error ?? q?.message)?.match(/emit asset (\d+) less than price limit (\d+)/);
            if (rejected && !explicitSlippage) {
              const emit = BigInt(rejected[1] ?? "0");
              const limit = BigInt(rejected[2] ?? "0");
              if (emit > 0n && limit > emit) {
                // limit = spot × (1 − tolerance/10000) → spot; needed = 1 − emit/spot.
                const spot = (limit * 10000n) / (10000n - BigInt(requestedTolerance));
                const needed = 10000n - (emit * 10000n) / spot + 50n; // +0.5% buffer
                if (needed <= MAX_TOLERANCE_BPS) q = await quoteOn(host, needed.toString());
              }
            }
          }
          // Validate the node's answer BEFORE touching the network again: a
          // rejection, a malformed quote or an unbound memo is final.
          if (q?.error || q?.message) {
            // The node's own rejection (no pool, price limit, halted…) is the
            // caller's answer — surface it instead of an anonymous null.
            params.onRefusal?.(`thorchain: ${String(q.error ?? q.message).slice(0, 200)}`);
            return null;
          }
          if (!q || !q.expected_amount_out || !q.inbound_address || !q.memo || !q.expiry) {
            params.onRefusal?.(`thorchain: incomplete quote from ${host} (expected_amount_out / inbound_address / memo / expiry missing)`);
            return null;
          }
          // A router is required for EVM and must be ABSENT for a deposit
          // source: a router on a Tron quote means the venue changed its
          // execution model and a plain send would no longer settle.
          if (chainId ? !q.router : !!q.router) {
            params.onRefusal?.(chainId ? "thorchain: quote has no router for an EVM source" : "thorchain: quote names a router for a deposit source — execution model changed");
            return null;
          }
          checkedMemo = verifiedMemo(q.memo, dst.asset, params.destAddress, params.refundAddress ?? "", configuredAffiliate, configuredAffiliateBps);
          if (!checkedMemo) {
            params.onRefusal?.(`thorchain: memo failed verification (${String(q.memo).slice(0, 80)})`);
            return null;
          }
          const floor1e8 = params.minAmountOut !== undefined ? toThorUnitsCeil(BigInt(params.minAmountOut), dst.decimals) : undefined;
          if (floor1e8 !== undefined && checkedMemo.limit < floor1e8) {
            params.onRefusal?.(`thorchain: floor breach (limit=${checkedMemo.limit} < floor=${floor1e8}, 1e8 units)`);
            return null;
          }
          // A quote gateway is not an authority for rotating vault/router
          // state. Bind it against a separately fetched no-store inbound
          // snapshot from the SAME host now, then repeat the check before broadcast.
          inbounds = await inboundAddressesOn(host, clientId);
          quoteHost = host;
          break;
        } catch (error) {
          if (error instanceof HostUnavailable) {
            q = null;
            checkedMemo = null;
            inbounds = null;
            continue;
          }
          throw error;
        }
      }
      if (!q?.expected_amount_out || !q.inbound_address || !q.expiry || !checkedMemo || !inbounds) {
        params.onRefusal?.(!inbounds ? "thorchain: inbound addresses unavailable from every node" : "thorchain: no quote from any node");
        return null;
      }
      const limit1e8 = checkedMemo.limit;
      const srcInbound = inbounds.find((entry) => entry.chain === THOR_CHAIN[params.sourceChain]);
      const dstInbound = inbounds.find((entry) => entry.chain === THOR_CHAIN[params.destChain]);
      if (paused(srcInbound) || paused(dstInbound)) {
        params.onRefusal?.(`thorchain: ${paused(srcInbound) ? THOR_CHAIN[params.sourceChain] : THOR_CHAIN[params.destChain]} chain is halted / paused on THORChain`);
        return null;
      }
      if (!sameTarget(srcInbound?.address, q.inbound_address)) {
        params.onRefusal?.("thorchain: quote inbound address differs from the node's current inbound (vault rotated) — retry");
        return null;
      }
      if (chainId && !sameTarget(srcInbound?.router, q.router)) {
        params.onRefusal?.("thorchain: quote router differs from the node's current router — retry");
        return null;
      }
      if (chainId && !pinnedRouter(params.sourceChain, q.router)) {
        params.onRefusal?.(`thorchain: router ${String(q.router)} is not a THORChain router this module trusts on ${params.sourceChain} (THORCHAIN_ROUTERS / trustedRouters)`);
        return null;
      }
      const unconfirmed = await confirmedElsewhere(quoteHost, params.sourceChain, q.inbound_address, chainId ? q.router : undefined);
      if (unconfirmed) {
        params.onRefusal?.(`thorchain: ${unconfirmed}`);
        return null;
      }
      const tooSmall = belowThorMinimums(amount1e8, srcInbound, q);
      if (tooSmall) {
        params.onRefusal?.(`thorchain: ${tooSmall}`);
        return null;
      }

      // expected_amount_out is 1e8 of the DEST asset → base units.
      const outUnits = (BigInt(q.expected_amount_out) * 10n ** BigInt(dst.decimals)) / 100000000n;
      if (outUnits <= 0n) {
        params.onRefusal?.("thorchain: expected output rounds to zero");
        return null;
      }
      const memoMinUnits = (limit1e8 * 10n ** BigInt(dst.decimals)) / 100_000_000n;
      const minUnits = memoMinUnits;
      if (minUnits <= 0n || minUnits > outUnits) {
        params.onRefusal?.(`thorchain: memo limit ${limit1e8} inconsistent with expected output ${q.expected_amount_out}`);
        return null;
      }
      // The caller's slippage is measured from the quoted output, as validQuote
      // does for every provider. A memo LIM below that floor would only be
      // dropped later as an anonymous validation failure — name it here.
      if (params.slippageBps !== undefined) {
        const slippageFloor = (outUnits * BigInt(10_000 - params.slippageBps)) / 10_000n;
        if (minUnits < slippageFloor) {
          params.onRefusal?.(`thorchain: memo limit ${limit1e8} is below expected ${q.expected_amount_out} minus ${params.slippageBps} bps slippage (1e8 units)`);
          return null;
        }
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const executionExpiry = Math.min(q.expiry, nowSeconds + 15 * 60);
      if (!Number.isInteger(executionExpiry) || executionExpiry <= nowSeconds + 30) {
        params.onRefusal?.(`thorchain: quote expires in ${Number.isInteger(executionExpiry) ? executionExpiry - nowSeconds : "?"} s — too soon to execute`);
        return null;
      }
      const assetAddr = (src.contract ? src.contract : NATIVE) as `0x${string}`;
      const common = {
        provider: "thorchain",
        intentId: `thorchain:${chainId ?? THOR_CHAIN[params.sourceChain]}`,
        sourceAmount: params.amountIn,
        destAmount: outUnits.toString(),
        minDestAmount: minUnits.toString(),
        feeUsd: 0, // destAmount is already net of THORChain fees
        etaSeconds: q.total_swap_seconds ?? 120,
        reliability: 0.9,
        // Validity must outlive the ERC-20 approval leg: for USDT that is
        // approve(0) + approve(n), each awaited to inclusion (≈2 blocks), so a
        // 60 s window expired before the deposit and only the revoke went out
        // (2026-09-16). The on-chain LIM bounds price movement and preflight
        // re-checks vault/router/halts right before broadcast, so a longer
        // window costs nothing in safety.
        validUntilMs: Math.min(Date.now() + QUOTE_VALIDITY_MS, executionExpiry * 1000),
        providerData: {
          sourceChain: params.sourceChain,
          destChain: params.destChain,
          inboundAddress: q.inbound_address,
          router: q.router ?? "",
          assetAddress: assetAddr,
          expiry: String(executionExpiry),
          memo: checkedMemo.canonical,
        },
      };

      // Deposit source (Tron): the engine sends `sourceAmount` of the source
      // asset to the inbound vault with the canonical memo attached on-chain.
      if (!chainId) {
        return {...common, depositAddress: q.inbound_address, depositMemo: checkedMemo.canonical};
      }

      // EVM: router calldata depositWithExpiry(asgardVault, asset, amount, memo, expiry).
      const data = encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "depositWithExpiry",
        args: [q.inbound_address as `0x${string}`, assetAddr, amountIn, checkedMemo.canonical, BigInt(executionExpiry)],
      });
      return {
        ...common,
        depositAddress: "",
        depositMemo: null,
        txRequest: {
          to: q.router!,
          data,
          value: src.contract ? "0" : params.amountIn,
          chainId: chainId!,
          ...(src.contract ? {approvalAddress: q.router!} : {}),
        },
      };
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      if (!quote.txRequest) {
        const sourceChain = quote.providerData?.sourceChain ?? "";
        if (!isDepositSource(sourceChain) || !quote.depositAddress || !quote.depositMemo) {
          throw new Error("thorchain: deposit-address execution is only supported for an opted-in Tron source");
        }
        // Plain send to the inbound vault (the engine turns a TRC-20 source
        // into transfer()); the memo MUST ride on-chain in raw_data.data.
        return {chain: sourceChain, to: quote.depositAddress, value: quote.sourceAmount, memo: quote.depositMemo};
      }
      return {
        chain: "",
        to: quote.txRequest?.to ?? "",
        value: quote.txRequest?.value ?? "0",
        ...(quote.txRequest?.data ? {data: quote.txRequest.data} : {}),
        ...(quote.txRequest?.chainId !== undefined ? {chainId: quote.txRequest.chainId} : {}),
        ...(quote.txRequest?.gasLimit ? {gasLimit: quote.txRequest.gasLimit} : {}),
        ...(quote.txRequest?.approvalAddress ? {approvalAddress: quote.txRequest.approvalAddress} : {}),
      };
    },

    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const data = quote.providerData;
      if (!data?.sourceChain || !data.destChain || !data.inboundAddress || !data.assetAddress || !data.expiry || !data.memo) {
        throw new Error("thorchain: quote is missing execution-bound metadata");
      }
      const evmSource = CHAIN_ID[data.sourceChain] !== undefined;
      if (evmSource && !data.router) throw new Error("thorchain: quote is missing execution-bound metadata");
      if (!evmSource && !isDepositSource(data.sourceChain)) throw new Error("thorchain: source chain has no executor");
      if (!/^\d+$/.test(data.expiry) || BigInt(data.expiry) <= BigInt(Math.floor(Date.now() / 1000))) {
        throw new Error("thorchain: quote expired before broadcast");
      }
      if (evmSource && !pinnedRouter(data.sourceChain, data.router)) throw new Error("thorchain: the quote's router is not one this module trusts");
      let inbounds: InboundAddress[] | null = null;
      let snapshotHost = "";
      for (const host of hosts) {
        try { inbounds = await inboundAddressesOn(host, clientId); snapshotHost = host; break; } catch (error) { if (!(error instanceof HostUnavailable)) throw error; }
      }
      if (!inbounds) throw new Error("thorchain: cannot refresh inbound addresses before broadcast");
      // The vault the funds go to is confirmed by a second node right before broadcast too (after this node's own checks).
      const confirm = async () => {
        const unconfirmed = await confirmedElsewhere(snapshotHost, data.sourceChain!, data.inboundAddress!, evmSource ? data.router : undefined);
        if (unconfirmed) throw new Error(`thorchain: ${unconfirmed}`);
      };
      const src = inbounds.find((entry) => entry.chain === THOR_CHAIN[data.sourceChain!]);
      const dst = inbounds.find((entry) => entry.chain === THOR_CHAIN[data.destChain!]);
      if (paused(src) || paused(dst)) throw new Error("thorchain: source or destination chain trading is paused");
      if (!sameTarget(src?.address, data.inboundAddress)) throw new Error("thorchain: inbound vault rotated after quote");
      if (!evmSource) {
        // Deposit source: exactly a plain send of the validated amount to the
        // validated vault carrying the validated memo — nothing else.
        if (tx.data !== undefined || tx.approvalAddress !== undefined || tx.bodyBoc !== undefined || tx.typedData !== undefined || tx.serializedTx !== undefined || tx.stateInitBoc !== undefined) {
          throw new Error("thorchain: deposit-address execution must be a plain send with memo");
        }
        if (!sameTarget(tx.to, data.inboundAddress) || tx.memo !== data.memo || tx.value !== quote.sourceAmount || (tx.chain && tx.chain !== data.sourceChain)) {
          throw new Error("thorchain: deposit does not match the validated quote");
        }
        const srcAsset = ccAssetByToken(data.sourceChain, sameTarget(data.assetAddress, NATIVE) ? "" : data.assetAddress);
        if (!srcAsset) throw new Error("thorchain: unknown source asset");
        const amount1e8 = (BigInt(quote.sourceAmount) * 100_000_000n) / 10n ** BigInt(srcAsset.decimals);
        const tooSmall = belowThorMinimums(amount1e8, src, null);
        if (tooSmall) throw new Error(`thorchain: ${tooSmall}`);
        await confirm();
        return;
      }
      if (!sameTarget(src?.router, data.router) || !sameTarget(tx.to, data.router)) {
        throw new Error("thorchain: router rotated after quote");
      }
      if (!tx.data) throw new Error("thorchain: missing depositWithExpiry calldata");
      let decoded: {functionName: string; args?: readonly unknown[]};
      try {
        decoded = decodeFunctionData({abi: ROUTER_ABI, data: tx.data as `0x${string}`});
      } catch {
        throw new Error("thorchain: malformed depositWithExpiry calldata");
      }
      const args = decoded.args;
      if (
        decoded.functionName !== "depositWithExpiry" || !args || args.length !== 5 ||
        !sameTarget(String(args[0]), data.inboundAddress) ||
        !sameTarget(String(args[1]), data.assetAddress) ||
        BigInt(args[2] as bigint) !== BigInt(quote.sourceAmount) ||
        String(args[3]) !== data.memo || BigInt(args[4] as bigint) !== BigInt(data.expiry) ||
        tx.chainId !== CHAIN_ID[data.sourceChain]
      ) {
        throw new Error("thorchain: calldata does not match the validated quote");
      }
      const tokenSource = !sameTarget(data.assetAddress, NATIVE);
      if (
        tx.value !== (tokenSource ? "0" : quote.sourceAmount) ||
        (tokenSource ? !sameTarget(tx.approvalAddress, data.router) : tx.approvalAddress !== undefined)
      ) {
        throw new Error("thorchain: value/approval does not match the validated source asset");
      }
      await confirm();
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash) return {state: "pending"}; // not broadcast yet
      // THORNode keys EVM inbounds by the tx hash without 0x, uppercase.
      if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(ref.sourceTxHash)) {
        throw new Error("thorchain: source transaction hash must be 32-byte hex");
      }
      const hash = ref.sourceTxHash.replace(/^0x/i, "").toUpperCase();
      const j = await thornodeGet(`/thorchain/tx/status/${hash}`, undefined, hosts, clientId) ??
        await thornodeGet(`/thorchain/tx/${hash}`, undefined, hosts, clientId);
      if (!j) return {state: "pending"};
      const stages = j.stages as {
        inbound_observed?: {started?: boolean; completed?: boolean};
        inbound_finalised?: {completed?: boolean};
        outbound_signed?: {completed?: boolean};
      } | undefined;
      if (stages) {
        const planned = (j.planned_out_txs ?? []) as {refund?: boolean}[];
        const refunded = planned.some((out) => out.refund === true);
        const delivered = planned.some((out) => out.refund === false);
        const outTxs = (j.out_txs ?? []) as {id?: string; memo?: string}[];
        const outHash = outTxs.find((out) => typeof out.id === "string" && out.id.length > 0 && !/^0+$/.test(out.id))?.id;
        const deliveredHash = outTxs.find((out) =>
          typeof out.id === "string" && out.id.length > 0 && !/^0+$/.test(out.id) && typeof out.memo === "string" && !/^REFUND/i.test(out.memo)
        )?.id;
        if (stages.outbound_signed?.completed) {
          // `completed` describes the signing stage, not the economic outcome.
          // A truncated/malformed status response with no classified plan or
          // observed outbound must not be promoted to successful delivery.
          if ((!refunded && !delivered) || !outHash) {
            return {state: "pending", depositReceived: true};
          }
          return refunded && delivered
            // A refund hash is not a destination transaction. For mixed plans,
            // expose a hash only when the observed outbound is classifiable.
            ? {state: "partial", depositReceived: true, ...(deliveredHash ? {destTxHash: deliveredHash} : {})}
            : refunded
            ? {state: "refunded", depositReceived: true}
            : {state: "completed", depositReceived: true, ...(outHash ? {destTxHash: outHash} : {})};
        }
        return {
          state: "pending",
          depositReceived: !!(stages.inbound_observed?.started || stages.inbound_observed?.completed || stages.inbound_finalised?.completed),
        };
      }
      const obs = j.observed_tx as {status?: string; out_hashes?: string[]} | undefined;
      const outHash = obs?.out_hashes?.find((h) => typeof h === "string" && h.length > 0 && !/^0+$/.test(h));
      if (obs?.status === "done") {
        // A slipped-past-LIM (or halted) swap ALSO finalizes "done", but its
        // outbound is a REFUND to the source chain — never report that as a
        // completed swap (audit M1). Planned outbounds carry the memo.
        const planned = (j.planned_out_txs ?? j.out_txs ?? []) as {memo?: string; refund?: boolean}[];
        const refunded = planned.some(
          (o) => o?.refund === true || /^REFUND/i.test(o?.memo ?? ""),
        );
        const delivered = planned.some(
          (o) => o?.refund === false && !/^REFUND/i.test(o?.memo ?? ""),
        );
        if ((!refunded && !delivered) || !outHash) return {state: "pending", depositReceived: true};
        if (refunded && delivered) return {state: "partial", depositReceived: true};
        if (refunded) return {state: "refunded", depositReceived: true};
        return {state: "completed", ...(outHash ? {destTxHash: outHash} : {})};
      }
      return {state: "pending", depositReceived: !!obs};
    },
  };
}
