import {thorchain as thorCfg} from "./config.js";
import {decodeFunctionData, encodeFunctionData} from "viem";
import {timeoutSignal} from "@forgewallet/protocol-swap2-core/util";
import {ccAsset, ccAssetByToken} from "@forgewallet/swap2-assets";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@forgewallet/protocol-swap2-core/types";

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
 * hand-build them (a wrong memo makes funds unrecoverable). A `tolerance_bps`
 * makes the quote embed an on-chain LIM, so a bad-price swap reverts.
 *
 * Hosts (re-verified 2026-09-16): ninerealms retired, the Liquify vanity
 * hostnames went stale; dev.thorchain.org now lists exactly two THORNode
 * entries — Liquify's public GATEWAY (50k req/day per IP; x-client-id
 * identifies us for a bump) and thornode.thorchain.network (no DNS today, kept
 * as the documented fallback in case it returns). Hosts are tried in order and
 * a quote is only ever bound to an inbound snapshot from the SAME host, so a
 * lagging secondary can never be compared against a primary's vault. The
 * list is an explicit constructor option (`nodeUrl`, one or many); this
 * package never reads deployment environment values.
 */

const HOSTS = [
  "https://gateway.liquify.com/chain/thorchain_api",
  "https://thornode.thorchain.network",
];

const DEFAULT_CLIENT_ID = "anywalletkit";

const NATIVE = "0x0000000000000000000000000000000000000000";
const TOLERANCE_BPS = "300"; // 3% max slippage, embedded as an on-chain LIM
// Thin pools (e.g. TRON.USDT) legitimately slip past 3% — the node then rejects
// the QUOTE itself ("emit asset less than price limit"). One adaptive retry
// widens the LIM to what the pool actually needs (+buffer), hard-capped here;
// routes worse than the cap stay hidden.
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

/** Pre-broadcast re-check: any live host is an acceptable authority — a
 *  disagreeing secondary fails closed, which is the safe direction. */
async function inboundAddresses(hosts: string[], clientId: string): Promise<InboundAddress[] | null> {
  for (const host of hosts) {
    try {
      return await inboundAddressesOn(host, clientId);
    } catch (error) {
      if (error instanceof HostUnavailable) continue;
      throw error;
    }
  }
  return null;
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
  /** Optional gateway identification; defaults to a neutral module name. */
  clientId?: string;
  /**
   * Opt-in Tron SOURCE execution: a native TRX send / TRC-20 transfer to the
   * inbound vault carrying the swap memo in `raw_data.data`. Ships dark: the
   * bound account MUST attach the memo on-chain (Tron via a prebuilt
   * TronWeb transaction + `addUpdateData`); a memo-less send is unsettleable.
   */
  tronSource?: boolean;
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
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("thorchain: nodeUrl must use http or https");
    return url.toString().replace(/\/$/, "");
  }))];
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
      if (!Number.isInteger(requestedTolerance) || requestedTolerance < 0 || requestedTolerance > Number(MAX_TOLERANCE_BPS)) return null;
      const quoteOn = async (host: string, bps: string): Promise<ThorQuoteResponse | null> => {
        const qs = new URLSearchParams({
          from_asset: fromAsset,
          to_asset: dst.asset,
          amount: amount1e8.toString(),
          destination: params.destAddress,
          tolerance_bps: bps,
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
      for (const host of hosts) {
        try {
          q = await quoteOn(host, String(requestedTolerance));
          // Adaptive retry: the rejection carries the actual emit vs the limit the
          // default tolerance implied — compute the tolerance this pool needs.
          const rejected = (q?.error ?? q?.message)?.match(/emit asset (\d+) less than price limit (\d+)/);
          if (rejected) {
            const emit = BigInt(rejected[1] ?? "0");
            const limit = BigInt(rejected[2] ?? "0");
            if (emit > 0n && limit > 0n) {
              // limit = spot × (1 − default/10000) → spot; needed = 1 − emit/spot.
              const spot = (limit * 10000n) / (10000n - BigInt(requestedTolerance));
              const needed = 10000n - (emit * 10000n) / spot + 50n; // +0.5% buffer
              // Never widen beyond an explicit caller limit. Adaptive widening is
              // retained only for legacy engine quotes with no requested slippage.
              if (params.slippageBps === undefined && needed <= MAX_TOLERANCE_BPS) {
                q = await quoteOn(host, needed.toString());
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
          if (!q || !q.expected_amount_out || !q.inbound_address || !q.memo || !q.expiry) return null;
          // A router is required for EVM and must be ABSENT for a deposit
          // source: a router on a Tron quote means the venue changed its
          // execution model and a plain send would no longer settle.
          if (chainId ? !q.router : !!q.router) return null;
          checkedMemo = verifiedMemo(q.memo, dst.asset, params.destAddress, params.refundAddress ?? "", configuredAffiliate, configuredAffiliateBps);
          if (!checkedMemo) return null;
          const floor1e8 = params.minAmountOut !== undefined ? toThorUnitsCeil(BigInt(params.minAmountOut), dst.decimals) : undefined;
          if (floor1e8 !== undefined && checkedMemo.limit < floor1e8) {
            params.onRefusal?.(`thorchain: floor breach (limit=${checkedMemo.limit} < floor=${floor1e8}, 1e8 units)`);
            return null;
          }
          // A quote gateway is not an authority for rotating vault/router
          // state. Bind it against a separately fetched no-store inbound
          // snapshot from the SAME host now, then repeat the check before broadcast.
          inbounds = await inboundAddressesOn(host, clientId);
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
      if (!q?.expected_amount_out || !q.inbound_address || !q.expiry || !checkedMemo || !inbounds) return null;
      const limit1e8 = checkedMemo.limit;
      const srcInbound = inbounds.find((entry) => entry.chain === THOR_CHAIN[params.sourceChain]);
      const dstInbound = inbounds.find((entry) => entry.chain === THOR_CHAIN[params.destChain]);
      if (paused(srcInbound) || paused(dstInbound) || !sameTarget(srcInbound?.address, q.inbound_address)) return null;
      if (chainId && !sameTarget(srcInbound?.router, q.router)) return null;
      const tooSmall = belowThorMinimums(amount1e8, srcInbound, q);
      if (tooSmall) {
        params.onRefusal?.(`thorchain: ${tooSmall}`);
        return null;
      }

      // expected_amount_out is 1e8 of the DEST asset → base units.
      const outUnits = (BigInt(q.expected_amount_out) * 10n ** BigInt(dst.decimals)) / 100000000n;
      if (outUnits <= 0n) return null;
      const memoMinUnits = (limit1e8 * 10n ** BigInt(dst.decimals)) / 100_000_000n;
      const minUnits = memoMinUnits;
      if (minUnits <= 0n || minUnits > outUnits) return null;

      const nowSeconds = Math.floor(Date.now() / 1000);
      const executionExpiry = Math.min(q.expiry, nowSeconds + 15 * 60);
      if (!Number.isInteger(executionExpiry) || executionExpiry <= nowSeconds + 30) return null;
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
      const inbounds = await inboundAddresses(hosts, clientId);
      if (!inbounds) throw new Error("thorchain: cannot refresh inbound addresses before broadcast");
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
