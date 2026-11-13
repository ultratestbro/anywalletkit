import type {RemotePins} from "@anywalletkit/protocol-swap2-core/types";
import {LIFI_SOLANA_CAIP2, lifi as lifiCfg} from "./config.js";
import {describeLifiActivity} from "./activity.js";
import {diamondCallMismatch} from "./calldata.js";
import {solanaBridgeTxMismatch} from "./solana.js";
import {timeoutSignal, sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {slippageFloor} from "@anywalletkit/protocol-swap2-core/validate";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {bigintToNumber} from "@anywalletkit/core";

/**
 * LI.FI meta-aggregator — the CALLDATA execution model: the quote returns a
 * `transactionRequest` the USER'S WALLET must execute. There is no deposit
 * address — a plain transfer to `transactionRequest.to` would lose funds, so
 * the client branches on `quote.txRequest`. Live-verified shapes (2026-07):
 * EVM → {to, data, value, chainId, gasLimit}; Solana → {data: base64 tx}, a
 * fully built v0 transaction (Jupiter route) the account signs after proving
 * its balance effects (`serializedTx`). Tron returns a raw protobuf we can't
 * hand to wallets yet — Tron stays on the direct NEAR Intents route (LI.FI
 * routes it through NEAR anyway, so nothing is lost).
 */

const DEFAULT_LIFI_BASE = "https://li.quest/v1";

/** Our CAIP-2 → LI.FI chain ids. */
const LIFI_CHAIN: Record<string, string> = {
  "eip155:1": "1",
  "eip155:8453": "8453",
  "eip155:56": "56",
  "eip155:137": "137",
  "eip155:42161": "42161",
  "eip155:10": "10",
  "eip155:100": "100",
  "eip155:143": "143",
  "eip155:130": "130",
  "eip155:999": "999",
  "eip155:4663": "4663",
  // 2026-08 sweep additions (all live on li.quest/v1/chains).
  "eip155:43114": "43114",
  "eip155:534352": "534352",
  "eip155:80094": "80094",
  // 2026-10-12: zkSync Era, Celo, MegaETH (live on li.quest/v1/chains).
  "eip155:324": "324",
  "eip155:42220": "42220",
  "eip155:4326": "4326",
  "eip155:9745": "9745",
  "eip155:59144": "59144",
  "eip155:146": "146",
  // 2026-10-13: World Chain, Sei, Ink, Plume, X Layer (live on li.quest/v1/chains).
  "eip155:480": "480",
  "eip155:1329": "1329",
  "eip155:57073": "57073",
  "eip155:98866": "98866",
  "eip155:196": "196",
  // 2026-10-14: Arc, Mantle, Katana, Morph, Flare (live on li.quest/v1/chains). On Arc LI.FI's "native" is the USDC
  // ERC-20 interface 0x3600…: a 0x0 fromToken is rewritten to it and the Diamond pulls via transferFrom (value 0), so
  // the catalog lists Arc USDC as that token — the engine then runs the ordinary approve + call path.
  "eip155:5042": "5042",
  "eip155:5000": "5000",
  "eip155:747474": "747474",
  "eip155:2818": "2818",
  "eip155:14": "14",
  // 2026-11-10: Elysium (Kinetiq; li.quest/v1/chains id 99901, key "ely"). LI.FI's bridges there are Relay (refused
  // below: UNBOUND_TOOLS) and LI.FI Intents (refused too: UNPINNED_TOOLS), so it has no cross-chain LI.FI route for now;
  // same-chain swaps go through GenericSwapFacetV3 (KyberSwap, Nordstern).
  "eip155:99901": "99901",
  [LIFI_SOLANA_CAIP2]: "1151111081099710",
};
const CAIP2_BY_LIFI_CHAIN: Record<string, string> = Object.fromEntries(Object.entries(LIFI_CHAIN).map(([caip2, id]) => [id, caip2]));

const EVM_ZERO = "0x0000000000000000000000000000000000000000";
/** LI.FI's native-SOL token id (the System program address). */
const SOLANA_NATIVE = "11111111111111111111111111111111";
const EVM_PLACEHOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
/** Dry-quote sender on Solana: the publicly known BIP-39 "abandon" account 0. */
const SOLANA_PLACEHOLDER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const isSolana = (chain: string) => chain === LIFI_SOLANA_CAIP2;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Chain-aware address equality: EVM case-insensitive, Solana exact base58. */
/** Longest execution a same-chain route may claim and still be an atomic swap (DEX routes report 0–30 s). */
const SAME_CHAIN_MAX_SECONDS = 90;
/** Largest fee a bridge may take from the input itself (glacis ≈ 0.25 %, 2026-10). Above it the quote is refused, named. */
const MAX_INPUT_FEE_BPS = 300;

function sameChainAddress(chain: string, actual: string | undefined, expected: string): boolean {
  if (isSolana(chain)) return !!actual && BASE58.test(actual) && actual === expected;
  return sameAddress(actual, expected);
}
/** The engine's native sentinel (`0x0…`) in the chain's own notation. */
function nativeFor(chain: string, token: string): string {
  if (/^0x0+$/.test(token) || token === SOLANA_NATIVE) return isSolana(chain) ? SOLANA_NATIVE : EVM_ZERO;
  return token;
}
/** LI.FI's documented Diamond entry point on most supported EVM networks. */
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
/**
 * Chains where the Diamond lives at a different address — from
 * github.com/lifinance/contracts `deployments/<chain>.json` (`LiFiDiamond`).
 * On these chains ONLY that address is the entry point; the canonical one is
 * not deployed there and is therefore not trusted.
 */
const LIFI_DIAMONDS: Readonly<Record<string, string>> = {
  "eip155:4663": "0xB477751B76CF82d00a686A1232f5fCD772414Af3", // Robinhood Chain (deployments/robinhood.json, verified 2026-10-09)
  "eip155:999": "0x0a0758d937d1059c356D4714e57F5df0239bce1A", // HyperEVM (deployments/hyperevm.json, verified 2026-10-09)
  "eip155:143": "0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37", // Monad (deployments/monad.json, verified 2026-10-11)
  "eip155:130": "0x864b314D4C5a0399368609581d3E8933a63b9232", // Unichain (deployments/unichain.json, verified 2026-10-11)
  "eip155:80094": "0xf909c4Ae16622898b885B89d7F839E0244851c66", // Berachain (deployments/berachain.json, verified 2026-10-11)
  "eip155:324": "0x341e94069f53234fE6DabeF707aD424830525715", // zkSync Era (deployments/zksync.json, matches a live quote 2026-10-12)
  "eip155:9745": "0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37", // Plasma (deployments/plasma.json, 2026-10-13)
  "eip155:59144": "0xDE1E598b81620773454588B85D6b5D4eEC32573e", // Linea (deployments/linea.json, 2026-10-13)
  "eip155:57073": "0x864b314D4C5a0399368609581d3E8933a63b9232", // Ink (deployments/ink.json, 2026-10-13)
  "eip155:98866": "0x6f5C8Bb0C5Fe4ECeAC40EE1C238EaB6bbb29761c", // Plume (deployments/plume.json, 2026-10-13)
  // 2026-10-14: li.quest/v1/chains `diamondAddress`, eth_getCode non-empty on each. Mantle and Flare carry the canonical
  // 0x1231… Diamond (the default).
  "eip155:5042": "0xA4072583658Fae592A3506A42431cb6316a8d40b", // Arc
  "eip155:747474": "0xC59fe32C9549e3E8B5dCcdAbC45BD287Bd5bA2bc", // Katana
  "eip155:2818": "0xF7aB42D00D2399f8A4Fba2F15466Be40709fe307", // Morph
  "eip155:14": "0x198FC70Dfe05E755C81e54bd67Bff3F729344B9b", // Flare (li.quest diamondAddress 2026-10-14; the canonical 0x1231… has no code there)
  // Elysium: li.quest diamondAddress = deployments/elysium.json LiFiDiamond; code on 99901, DiamondLoupe facets() serves
  // GenericSwapFacetV3 + LiFiIntentEscrowFacetV2; the canonical 0x1231… has no code there (all read 2026-11-10).
  "eip155:99901": "0x24E6dA91AA4A8FEe2447F542c92E006243bd6Dc5", // Elysium
  "eip155:4326": "0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37", // MegaETH (deployments/megaeth.json, matches a live quote 2026-10-12)
};
const diamondFor = (chain: string): string => LIFI_DIAMONDS[chain] ?? LIFI_DIAMOND;
const DEFAULT_QUOTE_TTL_MS = 55_000;

function normalizeAddress(value: string | undefined): string | null {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
}

function sameAddress(actual: string | undefined, expected: string): boolean {
  return normalizeAddress(actual) === normalizeAddress(expected);
}

function isHexData(value: string | undefined): value is string {
  return !!value && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

function trustedAddress(
  chain: string,
  address: string | undefined,
  configured: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const normalized = normalizeAddress(address);
  if (!normalized) return false;
  return normalizeAddress(diamondFor(chain)) === normalized || configured.get(chain)?.has(normalized) === true;
}

function trustMap(input: Readonly<Record<string, readonly string[]>> | undefined, label: string): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [chain, addresses] of Object.entries(input ?? {})) {
    const normalized = new Set<string>();
    for (const address of addresses) {
      const value = normalizeAddress(address);
      if (!value) throw new Error(`lifi: invalid ${label} address for ${chain}`);
      normalized.add(value);
    }
    out.set(chain, normalized);
  }
  return out;
}

/** LI.FI token id on the source chain: contract, or the chain's native id. */
function lifiToken(params: Pick<QuoteParams, "sourceChain" | "sourceToken" | "sourceDecimals">): string | null {
  const sourceChain = params.sourceChain;
  const asset = sourceAssetOf(params);
  if (!asset) return null;
  if (asset.contract) return asset.contract;
  return isSolana(sourceChain) ? SOLANA_NATIVE : EVM_ZERO;
}

function headers(key: string | undefined): Record<string, string> {
  const h: Record<string, string> = {accept: "application/json"};
  if (key) h["x-lifi-api-key"] = key;
  return h;
}

/** Explicit constructor configuration; no deployment environment is read. */
export interface LifiProviderConfig {
  enabled?: boolean;
  /** LI.FI REST base URL. Explicitly injectable for proxies and tests; must be https unless `allowInsecureApiUrl`. */
  apiUrl?: string;
  /**
   * Allow an `http:` `apiUrl` (local development only): the quotes and the Diamond calldata travel it, and over plain
   * http anyone on the path rewrites them (scan 2026-10-27 modules, F20).
   */
  allowInsecureApiUrl?: boolean;
  apiKey?: string;
  integrator?: string;
  /** Additional audited LI.FI entry points for networks whose Diamond differs. */
  trustedTransactionTargets?: Readonly<Record<string, readonly string[]>>;
  /** Additional audited ERC-20 spenders returned by LI.FI for direct routes. */
  trustedApprovalAddresses?: Readonly<Record<string, readonly string[]>>;
  /** Fail-closed local lifetime for the provider's documented ~60s quote window. */
  quoteTtlMs?: number;
  /**
   * Slippage sent when the caller names none (bps, default 50 = LI.FI's own
   * documented default). Left unset, LI.FI picks it per request and it swings
   * (0.9%–6% within a minute on Base ETH → Robinhood, 2026-10-12): the display
   * quote's minimum then sits above the live one and the execution floor
   * refuses a route that hasn't moved.
   */
  defaultSlippageBps?: number;
  /**
   * Route policy hook. When set, a cross-chain quote first asks LI.FI's
   * `/advanced/routes` for the candidates, hands them to this function and
   * restricts `/quote` to what it returns (allowBridges / denyBridges /
   * order). Returning null/undefined, or any failure of the routes call,
   * leaves LI.FI's default pick. The policy itself (tie band, max ETA, deny
   * list) belongs to the app; the module only carries the choice.
   */
  chooseRoute?: (routes: readonly LifiRouteOption[], params: QuoteParams) => LifiRouteChoice | null | undefined;
  /**
   * Ask LI.FI for one slippage budget for the whole route (`slippageScope=route`) on EVM → EVM requests, instead of
   * its default of applying the slippage to every step. The minimum is then one floor, `ceil(expected × (1 −
   * slippage))`, that the transaction (and on Across, Mayan and Stargate V2 the bridge) enforces. Only EVM routes
   * with at most one swap and no destination call can be protected so; when LI.FI has none for a request it is asked
   * again in its default (per-step) scope, held to the same floor by the module's checks. Default off: Solana legs and
   * a disabled flag keep the per-step behaviour exactly as before.
   */
  routeWideSlippage?: boolean;
}

/** One single-transaction candidate from `/advanced/routes`, as a route policy sees it. */
export interface LifiRouteOption {
  /** LI.FI tool key of the bridge the route crosses with (e.g. "stargateV2"); a same-chain route carries its swap tool. */
  tool: string;
  toAmount: bigint;
  toAmountMin: bigint;
  /** LI.FI's execution-duration estimate, seconds. */
  etaSeconds: number;
  gasCostUsd: number;
  /** LI.FI's own labels: RECOMMENDED, CHEAPEST, FASTEST, … */
  tags: readonly string[];
}

/** What `/quote` is restricted to. LI.FI tool keys; an empty choice means LI.FI's default. */
export interface LifiRouteChoice {
  allowBridges?: readonly string[];
  denyBridges?: readonly string[];
  order?: "CHEAPEST" | "FASTEST";
}

const TOOL_KEY = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * LI.FI tools whose Diamond entry point does not tie the delivery to the checked receiver (see `UNBOUND_BRIDGES` in
 * calldata.ts): every cross-chain request from an EVM chain asks LI.FI to route around them, so the pairs they would
 * have served get another bridge instead of a refusal. A Solana source has no Diamond call to check and is quoted
 * through every bridge LI.FI offers (Relay included); the account checks a Mayan order's recipient on the device, the
 * other Solana bridges only against its SOL and token ceilings.
 */
const UNBOUND_TOOLS: readonly string[] = Object.freeze(["relaydepository", "garden", "squid", "symbiosis"]);
/**
 * LI.FI Intents (`lifiIntents`): the escrowed order names its own input oracle, output oracle, output settler and output
 * amount multiplier, none of which is pinned here, so its Diamond call is refused on every route (calldata.ts,
 * `INTENTS_UNPINNED` / `INTENTS_TO_SOLANA`) and every cross-chain request from an EVM chain asks LI.FI to route around it,
 * like the unbound tools. A Solana source is unchanged (no Diamond call; see UNBOUND_TOOLS).
 */
const UNPINNED_TOOLS: readonly string[] = Object.freeze(["lifiIntents"]);
/** The LI.FI tools every cross-chain request from an EVM chain is asked to avoid, and a route policy cannot pick. */
const REFUSED_EVM_TOOLS: readonly string[] = Object.freeze([...UNBOUND_TOOLS, ...UNPINNED_TOOLS]);
/**
 * EVM → Solana: the LI.FI tools whose Diamond call binds the delivery to the Solana recipient the device reads
 * (calldata.ts, `solanaRecipientMismatch`): Mayan's Swift, MCTP and Fast MCTP routes, Polymer CCTP (fast and standard)
 * and Chainflip. Such requests ask LI.FI for these bridges only, so a pair is not lost to a bridge the module refuses
 * for this direction (NEAR Intents, LayerSwap and Smart Deposits pay a deposit address; LI.FI Intents names its own
 * oracles and output settler, which are not pinned here).
 */
const SOLANA_DESTINATION_TOOLS: readonly string[] = Object.freeze(["mayan", "mayanMCTP", "mayanFastMCTP", "polymer", "polymerStandard", "chainflip"]);
/** LI.FI's Smart Deposits pay a deposit address; nothing in the transaction binds where it delivers. */
const SMART_DEPOSITS_TOOL = /^smartdeposits?$/i;
/** A dry EVM → Solana quote without a recipient prices the publicly known BIP-39 "abandon" account 0 on Solana (never built: {@link placeholderIn}). */
const dryRecipient = (params: Pick<QuoteParams, "sourceChain" | "destChain">, fromAddress: string): string =>
  !isSolana(params.sourceChain) && isSolana(params.destChain) ? SOLANA_PLACEHOLDER : fromAddress;
/**
 * Which address of a dry request the module fills with its placeholder: the sender when there is no `refundAddress`
 * (vitalik.eth, or the Solana "abandon" account from Solana), the recipient of an EVM → Solana request without a
 * `destAddress` (the "abandon" account) — or null when the quote is for the request's own addresses (a dry EVM → EVM or
 * Solana-source quote without a recipient prices the sender's own address). The placeholders are public accounts, and
 * the Solana one's key anyone can derive and sweep: a transaction LI.FI builds for them pays or refunds them from
 * whichever wallet signs it. Such a quote therefore prices the route and carries no transaction; `buildDeposit`
 * refuses it and {@link lifiVerifyQuote} refuses one that carries a transaction anyway.
 */
function placeholderIn(params: Pick<QuoteParams, "sourceChain" | "destChain" | "refundAddress" | "destAddress">): "sender" | "recipient" | null {
  if (!params.refundAddress) return "sender";
  return !params.destAddress && dryRecipient(params, params.refundAddress) !== params.refundAddress ? "recipient" : null;
}
function routeOptions(body: unknown, excluded: readonly string[], allowed?: readonly string[]): LifiRouteOption[] {
  const routes = (body as {routes?: unknown})?.routes;
  if (!Array.isArray(routes)) return [];
  const out: LifiRouteOption[] = [];
  for (const r of routes as {toAmount?: unknown; toAmountMin?: unknown; gasCostUSD?: unknown; containsSwitchChain?: unknown; tags?: unknown; steps?: {tool?: unknown; estimate?: {executionDuration?: unknown}; includedSteps?: {tool?: unknown; type?: unknown}[]}[]}[]) {
    // The engine executes one source transaction: multi-step routes are not candidates.
    if (!Array.isArray(r?.steps) || r.steps.length !== 1 || r.containsSwitchChain === true) continue;
    const step = r.steps[0]!;
    const cross = Array.isArray(step.includedSteps) ? step.includedSteps.find((i) => i?.type === "cross")?.tool : undefined;
    const tool = typeof cross === "string" ? cross : step.tool;
    const eta = step.estimate?.executionDuration;
    if (typeof tool !== "string" || !TOOL_KEY.test(tool) || excluded.includes(tool) || (allowed && !allowed.includes(tool)) || typeof eta !== "number" || !Number.isFinite(eta) || eta < 0) continue;
    if (typeof r.toAmount !== "string" || typeof r.toAmountMin !== "string" || !/^\d{1,60}$/.test(r.toAmount) || !/^\d{1,60}$/.test(r.toAmountMin)) continue;
    out.push({
      tool,
      toAmount: BigInt(r.toAmount),
      toAmountMin: BigInt(r.toAmountMin),
      etaSeconds: eta,
      gasCostUsd: Number(r.gasCostUSD ?? 0) || 0,
      tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    });
  }
  return out;
}

function cleanChoice(choice: LifiRouteChoice | null | undefined): LifiRouteChoice | null {
  if (!choice) return null;
  const allow = (choice.allowBridges ?? []).filter((t) => TOOL_KEY.test(t));
  const deny = (choice.denyBridges ?? []).filter((t) => TOOL_KEY.test(t));
  const order = choice.order === "CHEAPEST" || choice.order === "FASTEST" ? choice.order : undefined;
  if (!allow.length && !deny.length && !order) return null;
  return {...(allow.length ? {allowBridges: allow} : {}), ...(deny.length ? {denyBridges: deny} : {}), ...(order ? {order} : {})};
}

export function lifiProvider(config: LifiProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const apiKey = () => config.apiKey;
  const integrator = () => config.integrator ?? "";
  const parsedApiUrl = new URL(config.apiUrl ?? DEFAULT_LIFI_BASE);
  if (parsedApiUrl.protocol !== "https:" && !(parsedApiUrl.protocol === "http:" && config.allowInsecureApiUrl === true)) {
    throw new Error("lifi: apiUrl must use https (allowInsecureApiUrl for local development)");
  }
  const apiBase = parsedApiUrl.toString().replace(/\/$/, "");
  const trustedTransactionTargets = trustMap(config.trustedTransactionTargets, "transaction target");
  const trustedApprovalAddresses = trustMap(config.trustedApprovalAddresses, "approval");
  const quoteTtlMs = config.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  const defaultSlippageBps = config.defaultSlippageBps ?? 50;
  if (!Number.isInteger(defaultSlippageBps) || defaultSlippageBps <= 0 || defaultSlippageBps >= 10_000) {
    throw new Error("lifi: defaultSlippageBps must be an integer between 1 and 9999");
  }
  if (!Number.isInteger(quoteTtlMs) || quoteTtlMs <= 0 || quoteTtlMs > 60_000) {
    throw new Error("lifi: quoteTtlMs must be an integer between 1 and 60000");
  }
  return {
    name: "lifi",
    describeActivity: (tx, ctx) => describeLifiActivity(tx, ctx, (chain, address) => trustedAddress(chain, address, trustedTransactionTargets)),
    supportsSameChain: true,
    enabled: () => config.enabled ?? true,

    // Capability discovery comes from the provider itself, so it can run alone
    // or inside the optional aggregator without a central capability table.
    supportsChain: (chain: string) => lifiCfg.supportsChain(chain),
    supportsChainPair: (fromChain: string, toChain: string) => lifiCfg.supports(fromChain, toChain),
    supportsRoute(from: Asset, to: Asset): boolean {
      // EVM only: LI.FI's Solana/Tron legs come back as provider-serialized
      // transactions, which the swap2 engine does not execute yet.
      return !!LIFI_CHAIN[from.chain] && !!LIFI_CHAIN[to.chain];
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      /** Every refusal after LI.FI answered is named — a bare null hides which check failed (matrix v7: 4 silent nulls). */
      const reject = (why: string): null => { params.onRefusal?.(`lifi: ${why}`); return null; };
      if (params.flex) return null; // calldata model — the amount is baked in
      const fromChain = LIFI_CHAIN[params.sourceChain];
      const toChain = LIFI_CHAIN[params.destChain];
      if (!fromChain || !toChain) return null;
      const fromToken = lifiToken(params);
      if (!fromToken) return null;

      const solanaSource = isSolana(params.sourceChain);
      const crossChain = params.sourceChain !== params.destChain;
      // EVM → Solana: only the bridges whose Solana recipient the calldata check reads (SOLANA_DESTINATION_TOOLS).
      const evmToSolana = !solanaSource && isSolana(params.destChain);
      // The Diamond check refuses a destination call (its recipient sits in calldata for the other chain), so LI.FI is
      // asked not to offer one; the check stays as the backstop. A Solana source has no Diamond call to check.
      const noDestinationCall = crossChain && !solanaSource;
      // Route-wide slippage covers EVM routes only (LI.FI: not a route that starts or ends on a non-EVM chain).
      let routeScope = config.routeWideSlippage === true && !solanaSource && !isSolana(params.destChain);
      // The placeholders price a dry quote; a live one is built for real addresses only (round 3, H8). A quote priced for
      // a placeholder carries no transaction (placeholderIn).
      const dry = params.dry !== false;
      const fromAddress = params.refundAddress || (dry ? (solanaSource ? SOLANA_PLACEHOLDER : EVM_PLACEHOLDER) : "");
      const toAddress = params.destAddress || (dry ? dryRecipient(params, fromAddress) : "");
      if (!fromAddress) return reject("a live quote needs the sender's address");
      if (!toAddress) return reject("a live quote needs a recipient");
      const placeholder = dry ? placeholderIn(params) : null;

      // LI.FI applies `slippage` to EACH step of a multi-step route (bridge +
      // destination swap), so its minimum can sit ~2× the requested slippage
      // under the quote (seen 2026-10-10 on 479 of 4 000 matrix quotes), and
      // it truncates toAmountMin to a few significant digits. The engine
      // rejects a floor below the requested one, so the quote is asked once
      // more with the slippage scaled down to land the floor inside it.
      const slippageBps = params.slippageBps ?? defaultSlippageBps;
      let sentSlippage: number | undefined = slippageBps / 10_000;
      let deadline: AbortSignal | undefined;
      let choice: LifiRouteChoice | null = null;
      if (config.chooseRoute && crossChain) {
        try {
          const res = await fetch(`${apiBase}/advanced/routes`, {
            method: "POST",
            headers: {...headers(apiKey()), "content-type": "application/json"},
            body: JSON.stringify({
              fromChainId: Number(fromChain),
              toChainId: Number(toChain),
              fromTokenAddress: fromToken,
              toTokenAddress: nativeFor(params.destChain, params.destToken),
              fromAmount: params.amountIn,
              fromAddress,
              toAddress,
              options: {
                slippage: slippageBps / 10_000,
                ...(routeScope ? {slippageScope: "route"} : {}),
                ...(solanaSource ? {} : {bridges: {...(evmToSolana ? {allow: SOLANA_DESTINATION_TOOLS} : {}), deny: REFUSED_EVM_TOOLS}}),
                ...(noDestinationCall ? {allowDestinationCall: false} : {}),
                ...(integrator().trim() ? {integrator: integrator().trim()} : {}),
              },
            }),
            signal: signal ?? timeoutSignal(8_000),
          });
          if (res.ok) {
            const options = routeOptions(await res.json(), solanaSource ? [] : REFUSED_EVM_TOOLS, evmToSolana ? SOLANA_DESTINATION_TOOLS : undefined);
            if (options.length) choice = cleanChoice(config.chooseRoute(options, params));
          }
        } catch {
          // The policy is an optimisation: no candidates means LI.FI's default pick.
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) try {
        const url = new URL(`${apiBase}/quote`);
        url.searchParams.set("fromChain", fromChain);
        url.searchParams.set("toChain", toChain);
        url.searchParams.set("fromToken", fromToken);
        // Native dest is chain-notation-specific: EVM zero address vs the
        // Solana system program — sending the EVM zero to an SVM dest 400s.
        url.searchParams.set("toToken", nativeFor(params.destChain, params.destToken));
        url.searchParams.set("fromAmount", params.amountIn);
        url.searchParams.set("fromAddress", fromAddress);
        url.searchParams.set("toAddress", toAddress);
        const integratorId = integrator().trim();
        if (integratorId) url.searchParams.set("integrator", integratorId);
        if (sentSlippage !== undefined) {
          url.searchParams.set("slippage", String(sentSlippage));
        }
        if (routeScope) url.searchParams.set("slippageScope", "route");
        if (noDestinationCall) url.searchParams.set("allowDestinationCall", "false");
        const unbound = crossChain && !solanaSource ? REFUSED_EVM_TOOLS : [];
        const allow = (choice?.allowBridges ?? []).filter((b) => solanaSource || !REFUSED_EVM_TOOLS.includes(b));
        // EVM → Solana: the policy's pick among the readable bridges, or all of them.
        const solanaAllow = evmToSolana ? allow.filter((b) => SOLANA_DESTINATION_TOOLS.includes(b)) : [];
        for (const t of evmToSolana ? (solanaAllow.length ? solanaAllow : SOLANA_DESTINATION_TOOLS) : allow) url.searchParams.append("allowBridges", t);
        for (const t of new Set([...(choice?.denyBridges ?? []), ...unbound])) url.searchParams.append("denyBridges", t);
        if (choice?.order) url.searchParams.set("order", choice.order);
        deadline = signal ? undefined : timeoutSignal(12_000);
        const res = await fetch(url, {headers: headers(apiKey()), signal: signal ?? deadline!});
        if (!res.ok && choice) {
          // The chosen bridge went away between the two calls: LI.FI's default pick instead.
          choice = null;
          attempt--;
          continue;
        }
        if (!res.ok) {
          // LI.FI's 404 "No available quotes for the requested transfer" and
          // 400 validation messages are the caller's answer, not a silent null.
          const body = (await res.json().catch(() => null)) as {message?: unknown; errors?: {filteredOut?: {reason?: unknown}[]}} | null;
          // When every candidate route was dropped for the same reason (Sei: "wallet is not linked to
          // the original SEI address"), that reason is the real answer — the message alone is generic.
          const reasons = [...new Set((body?.errors?.filteredOut ?? []).map((f) => f.reason).filter((r): r is string => typeof r === "string"))];
          if (routeScope && [typeof body?.message === "string" ? body.message : "", ...reasons].some((r) => /^ROUTE_SLIPPAGE_(UNSUPPORTED|UNAVAILABLE)/.test(r))) {
            // No route LI.FI can protect route-wide (or the feature is off): its default per-step scope instead,
            // whose minimum the floor check below still holds to the requested slippage. Both reasons are LI.FI's
            // documented stable prefixes (docs.li.fi/api-reference/error-codes, "Route-wide slippage errors";
            // docs.li.fi/guides/route-wide-slippage#errors): ROUTE_SLIPPAGE_UNSUPPORTED in errors.filteredOut when no
            // route can be protected, ROUTE_SLIPPAGE_UNAVAILABLE (422, code 1004) in `message` when route-wide
            // slippage is switched off. This happens before any quote is shown: the user reviews the step-scope one.
            routeScope = false;
            attempt--;
            continue;
          }
          const why = reasons.length === 1 ? ` (${reasons[0]!.slice(0, 200)})` : "";
          params.onRefusal?.(`lifi: ${typeof body?.message === "string" ? body.message.slice(0, 200) : `HTTP ${res.status}`}${why}`);
          return null;
        }
        const q = (await res.json()) as {
          type?: string;
          id?: string;
          action?: {
            fromToken?: {address?: string; chainId?: number};
            toToken?: {address?: string; chainId?: number; decimals?: number};
            fromAmount?: string;
            fromChainId?: number;
            toChainId?: number;
            slippage?: number;
            fromAddress?: string;
            toAddress?: string;
          };
          estimate?: {
            fromAmount?: string;
            toAmount?: string;
            toAmountMin?: string;
            executionDuration?: number;
            approvalAddress?: string;
            feeCosts?: {amountUSD?: string}[];
            gasCosts?: {amountUSD?: string}[];
          };
          transactionRequest?: {
            to?: string;
            data?: string;
            value?: string;
            chainId?: number;
            gasLimit?: string;
            from?: string;
          };
        };
        const receivedAt = Date.now();
        if (evmToSolana) {
          const steps = (q as {includedSteps?: unknown}).includedSteps;
          const tools = [(q as {tool?: unknown}).tool, ...(Array.isArray(steps) ? steps.map((i: {tool?: unknown} | null) => i?.tool) : [])];
          if (tools.some((t) => typeof t === "string" && SMART_DEPOSITS_TOOL.test(t))) {
            return reject("LI.FI Smart Deposits pay a deposit address whose recipient the transaction does not bind — refused for a Solana destination");
          }
        }
        const action = q.action;
        const est = q.estimate;
        const tr = q.transactionRequest;
        const expectedToToken = nativeFor(params.destChain, params.destToken);
        const expectedFromChain = Number(fromChain);
        const expectedToChain = Number(toChain);
        if (q.type !== "lifi" || !q.id || !action || !est?.toAmount || !est.fromAmount || !tr) return reject("incomplete quote (no action, estimate or transaction)");
        const mismatch = [
          action.fromChainId !== expectedFromChain && "source chain",
          action.toChainId !== expectedToChain && "destination chain",
          (action.fromToken?.chainId !== expectedFromChain || !sameChainAddress(params.sourceChain, action.fromToken?.address, fromToken)) && "source token",
          (action.toToken?.chainId !== expectedToChain || !sameChainAddress(params.destChain, action.toToken?.address, expectedToToken)) && "destination token",
          action.fromAmount !== params.amountIn && "amount spent",
          !sameChainAddress(params.sourceChain, action.fromAddress, fromAddress) && "sender",
          !sameChainAddress(params.destChain, action.toAddress, toAddress) && "recipient",
        ].filter(Boolean);
        if (mismatch.length) return reject(`quote does not match the request (${mismatch.join(", ")})`);
        // The transaction spends exactly the input (action.fromAmount, checked above). Some bridges
        // (glacis, 2026-10) take their fee from the input, so estimate.fromAmount — what is bridged —
        // is a little lower and toAmount already reflects it. Accept a bounded input-side fee instead
        // of a silent null; never an estimate that bridges MORE than is spent.
        const bridged = BigInt(est.fromAmount);
        const spent = BigInt(params.amountIn);
        if (bridged > spent) return reject(`the estimate bridges ${est.fromAmount}, more than the ${params.amountIn} spent`);
        if ((spent - bridged) * 10_000n > spent * BigInt(MAX_INPUT_FEE_BPS)) {
          return reject(`the route takes ${bigintToNumber(((spent - bridged) * 10_000n) / spent) / 100}% of the input as a fee (over ${MAX_INPUT_FEE_BPS / 100}%)`);
        }
        // Source-VM execution payload. EVM: calldata to a trusted target.
        // Solana: a base64 transaction the account proves before signing —
        // there is no target to trust here, the balance proof replaces it.
        if (solanaSource) {
          if (!tr.data || tr.data.length < 64 || tr.data.length % 4 !== 0 || !BASE64.test(tr.data)) return reject("the Solana transaction is not base64");
          if (tr.to !== undefined || tr.value !== undefined || tr.gasLimit !== undefined) return reject("the Solana transaction carries EVM fields");
          if (fromChain !== toChain) {
            const why = solanaBridgeTxMismatch(tr.data, fromAddress);
            if (why) return reject(why);
          }
          // `estimate.approvalAddress` is ignored for a Solana source: LI.FI
          // returns its EVM diamond here on Mayan routes too (seen 2026-10-09,
          // SOL → Base USDC via mayanFastMCTP), and Solana has no allowances —
          // the account's post-state balance proof is the guard, not an
          // approval target. It is never propagated.
        } else if (
          !isHexData(tr.data) || !normalizeAddress(tr.to) || !normalizeAddress(tr.from) ||
          tr.chainId !== expectedFromChain || !tr.value || !tr.gasLimit ||
          !trustedAddress(params.sourceChain, tr.to, trustedTransactionTargets) ||
          !sameAddress(tr.from, fromAddress)
        ) return reject("the transaction is malformed or targets an untrusted contract");
        if (
          sentSlippage !== undefined &&
          (typeof action.slippage !== "number" || Math.abs(action.slippage - sentSlippage) > 1e-12)
        ) return reject("the quote ignored the requested slippage");

        const sourceIsToken = fromToken !== EVM_ZERO && fromToken !== SOLANA_NATIVE;
        if (solanaSource) {
          // No allowances on Solana; nothing to trust beyond the balance proof.
        } else if (sourceIsToken) {
          if (!trustedAddress(params.sourceChain, est.approvalAddress, trustedApprovalAddresses)) return reject("the approval target is not a trusted LI.FI contract");
        } else if (est.approvalAddress !== undefined) {
          // LI.FI started returning an approvalAddress for NATIVE sources too
          // (seen 2026-09 on every ETH-source quote, e.g. ETH → Robinhood via
          // relay: approvalAddress = the diamond the tx already calls). An
          // approval is meaningless for the native asset, so it is not a
          // reason to refuse the quote — but it must still be a trusted
          // target, and it is never propagated for a native source.
          if (!trustedAddress(params.sourceChain, est.approvalAddress, trustedApprovalAddresses)) return reject("the approval target is not a trusted LI.FI contract");
        }

        let txRequest: NonNullable<Quote["txRequest"]>;
        // The bridge's native fee on top of the input (EVM source); a price-only quote declares it in providerData.
        let nativeFee = 0n;
        if (solanaSource) {
          // `value` declares what the account may let the tx take in native
          // coin: the input for a SOL source, nothing for a token source.
          txRequest = {serializedTx: tr.data!, value: sourceIsToken ? "0" : params.amountIn};
        } else {
          try {
            if (BigInt(tr.value!) < 0n || BigInt(tr.gasLimit!) <= 0n) return reject("the transaction has a negative value or no gas limit");
          } catch {
            return reject("the transaction value or gas limit is not a number");
          }
          // Some bridges charge a native messaging fee inside `value`: for a
          // token source the whole value is that fee; for a native source it
          // is whatever exceeds the input (seen 2026-10-10: DAI Optimism →
          // Base, POL Polygon → Optimism). Declared here, sealed with the
          // quote, bounded by the engine — never silently attached.
          const value = BigInt(tr.value!);
          nativeFee = sourceIsToken ? value : value > BigInt(params.amountIn) ? value - BigInt(params.amountIn) : 0n;
          if (!sourceIsToken && value < BigInt(params.amountIn)) return reject("the transaction sends less native coin than the input");
          txRequest = {
            to: tr.to!,
            data: tr.data!,
            value: value.toString(),
            chainId: tr.chainId!,
            gasLimit: BigInt(tr.gasLimit!).toString(),
            ...(sourceIsToken && est.approvalAddress ? {approvalAddress: est.approvalAddress} : {}),
            ...(nativeFee > 0n ? {nativeFee: nativeFee.toString()} : {}),
          };
        }

        // Route fees only (bridge / protocol / integrator). The source
        // transaction's gas is the network fee the wallet shows on its own line —
        // counting it here too made LI.FI look dearer than on-chain venues whose
        // fee excludes gas (2026-10-13).
        const feeUsd = (est.feeCosts ?? []).reduce((a, f) => a + Number(f.amountUSD ?? 0), 0);

        // The optimistic output is not a safety floor. A quote without the
        // provider's minimum cannot satisfy an exact-input execution contract.
        if (!est.toAmountMin) return reject("the quote has no minimum output");
        const minDestAmount = est.toAmountMin;
        if (sentSlippage !== undefined) {
          const dest = BigInt(est.toAmount);
          const min = BigInt(minDestAmount);
          if (dest > 0n && min < slippageFloor(dest, slippageBps)) {
            const effective = bigintToNumber(((dest - min) * 1_000_000n) / dest) / 1_000_000;
            const requested = slippageBps / 10_000;
            const scaled: number = Math.floor(((sentSlippage * requested) / effective) * 0.995 * 1_000_000) / 1_000_000;
            if (attempt === 0 && effective > 0 && scaled > 0) {
              sentSlippage = scaled;
              continue;
            }
            params.onRefusal?.(
              `lifi: this route's minimum is ${(effective * 100).toFixed(2)}% under the quote (LI.FI applies slippage on every step) — more than the requested ${slippageBps / 100}%`,
            );
            return null;
          }
        }
        if (params.minAmountOut !== undefined && BigInt(minDestAmount) < BigInt(params.minAmountOut)) {
          params.onRefusal?.(`lifi: floor breach (min=${minDestAmount} < floor=${params.minAmountOut})`);
          return null;
        }
        // A same-chain swap must deliver in the same transaction. LI.FI sometimes routes a
        // same-chain pair through a solver (Relay-style intents, 2026-10: USDC → ARB on
        // Ethereum, 625 s): the tx only takes the input and the output arrives later from the
        // solver, so the engine's "output ≥ quoted minimum" preflight would refuse it anyway.
        // Name it here, before anything is built.
        const duration = est.executionDuration ?? 0;
        if (fromChain === toChain && duration > SAME_CHAIN_MAX_SECONDS) {
          params.onRefusal?.(`lifi: same-chain route settles asynchronously (${duration} s via ${(q as {tool?: string}).tool ?? "unknown tool"}) — a same-chain swap must deliver in the same transaction`);
          return null;
        }
        // The calldata is what gets signed: it must pay the reviewed recipient at least the reviewed
        // minimum, in the requested tokens (round 3, H9), and refund only the sender or the recipient.
        if (!solanaSource) {
          const why = diamondCallMismatch(tr.data!, {
            fromToken, toToken: expectedToToken, amountIn: BigInt(params.amountIn), receiver: toAddress, sender: fromAddress, minOut: BigInt(minDestAmount),
            destChainId: BigInt(toChain), sameChain: fromChain === toChain, evmDestination: !isSolana(params.destChain),
          });
          if (why) return reject(`the transaction does not match the quote: ${why}`);
        }
        return {
          provider: "lifi",
          // Status is tracked by SOURCE TX HASH + the chain pair.
          intentId: `lifi:${fromChain}:${toChain}`,
          depositAddress: "",
          depositMemo: null,
          // Every check above ran on LI.FI's transaction; one built for a placeholder is not handed out (placeholderIn).
          // Its bridge fee on top of the input still is, as `providerData.nativeFee`, so the router's value nets it out
          // (usdValue reads it when there is no txRequest) instead of ranking the route on its gross output.
          ...(placeholder ? {providerData: {placeholder, ...(nativeFee > 0n ? {nativeFee: nativeFee.toString()} : {})}} : {txRequest}),
          // What the wallet spends (action.fromAmount, = the input); an input-side bridge fee is inside destAmount.
          sourceAmount: params.amountIn,
          destAmount: est.toAmount,
          minDestAmount,
          ...(Number.isInteger(action.toToken?.decimals) && action.toToken!.decimals! >= 0 && action.toToken!.decimals! <= 36 ? {destDecimals: action.toToken!.decimals!} : {}),
          feeUsd,
          etaSeconds: est.executionDuration ?? 120,
          reliability: 0.97,
          // LI.FI documents an approximately 60-second lifetime. Use a slightly
          // shorter local deadline and re-quote again at execution time.
          validUntilMs: receivedAt + quoteTtlMs,
        };
      } catch {
        // Our own 12 s deadline (not the caller's signal): say so instead of a silent null.
        if (deadline?.aborted) params.onRefusal?.("lifi: no quote within 12 s");
        return null;
      }
      return null;
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      // A dry quote priced for a placeholder sender or recipient (placeholderIn) is never built, even with a transaction attached.
      const placeholder = quote.providerData?.placeholder;
      if (placeholder !== undefined) {
        throw new Error(`swap2: this LI.FI quote was priced for a placeholder ${String(placeholder).slice(0, 20)} (a dry quote without that address) and has no transaction to build — quote again with the sender and the recipient`);
      }
      const tx = quote.txRequest;
      if (!tx) throw new Error("swap2: LI.FI quote has no transaction request");
      // The intent id carries the LI.FI source chain; a serialized leg names
      // its chain so the engine can refuse a mismatched account.
      const [, fromChain] = quote.intentId.split(":");
      return {
        chain: tx.serializedTx ? CAIP2_BY_LIFI_CHAIN[fromChain ?? ""] ?? "" : "",
        to: tx.to ?? "",
        value: tx.value ?? "0",
        ...(tx.data ? {data: tx.data} : {}),
        ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}),
        ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}),
        ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {}),
        ...(tx.serializedTx ? {serializedTx: tx.serializedTx} : {}),
      };
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash) return {state: "pending"}; // not broadcast yet
      const [, fromChain, toChain] = ref.intentId.split(":");
      try {
        const url = new URL(`${apiBase}/status`);
        url.searchParams.set("txHash", ref.sourceTxHash);
        if (fromChain) url.searchParams.set("fromChain", fromChain);
        if (toChain) url.searchParams.set("toChain", toChain);
        const res = await fetch(url, {headers: headers(apiKey()), signal: timeoutSignal(12_000)});
        if (!res.ok) return {state: "pending"};
        const s = (await res.json()) as {status?: string; substatus?: string; receiving?: {txHash?: string}};
        const map: Record<string, IntentStatus["state"]> = {
          DONE: "completed",
          FAILED: "failed",
          // LI.FI cannot process the transaction: it never completes (round 3, L17).
          INVALID: "failed",
          PENDING: "pending",
          NOT_FOUND: "pending",
        };
        // LI.FI reports refunds and partial fills as top-level DONE. Treating
        // those as completed would falsely claim that the destination was fully
        // funded. Keep the explicit partial/refund lifecycle states.
        const state = s.substatus === "REFUNDED"
          ? "refunded"
          : s.substatus === "EXPIRED"
            ? "expired"
            : s.substatus === "NOT_PROCESSABLE_REFUND_NEEDED"
              ? "action-required"
              : s.substatus === "REFUND_IN_PROGRESS"
                ? "refund-pending"
                : s.status === "DONE" && s.substatus === "PARTIAL"
                  ? "partial"
                  : map[s.status ?? "PENDING"] ?? "pending";
        const depositReceived = state === "pending" && s.status === "PENDING";
        const destTxHash = typeof s.receiving?.txHash === "string" && s.receiving.txHash.length > 0
          ? s.receiving.txHash
          : undefined;
        return {
          state,
          depositReceived,
          ...(destTxHash ? {destTxHash} : {}),
        };
      } catch {
        return {state: "pending"};
      }
    },
  };
}

/**
 * A remote LI.FI quote's Diamond call, decoded on the device against the app's own request (scan 2026-10-30, F3) —
 * the same {@link diamondCallMismatch} the provider runs on LI.FI's answer, with the expectation it builds: the input
 * token and amount, the requested output token, the recipient, the quoted minimum (at least the caller's floor), the
 * destination chain. A native input is paid in value (any excess is the declared bridge fee); a token input attaches
 * only that declared fee and approves the Diamond. A Solana source carries a serialized transaction instead, which the
 * account proves before signing (for a Mayan bridge, against the engine's `bridgeOut`); here only its static part is
 * read (paid by the sender; a Mayan route pays SOL to no other wallet). A dry request without the sender, or an EVM →
 * Solana one without the recipient, is priced for a placeholder: its quote must carry no transaction and is held to its
 * terms only. The reason it fails, or null.
 */
export function lifiVerifyQuote(params: QuoteParams, quote: Quote): string | null {
  const fromChain = LIFI_CHAIN[params.sourceChain];
  const toChain = LIFI_CHAIN[params.destChain];
  if (!fromChain || !toChain) return "not a LI.FI chain pair";
  // A dry quote priced for a placeholder sender or recipient (placeholderIn) prices the route only: with a transaction
  // it would pay or refund that public account from whichever wallet signs it.
  const placeholder = params.dry !== false ? placeholderIn(params) : null;
  if (placeholder) {
    if (quote.txRequest !== undefined) return `a dry quote priced for a placeholder ${placeholder} carries a transaction — it would pay or refund that placeholder, not the wallet that signs it`;
    return priceOnlyMismatch(params, quote, `lifi:${fromChain}:${toChain}`);
  }
  const tx = quote.txRequest;
  if (!tx) return "the quote carries no transaction";
  if (isSolana(params.sourceChain)) {
    if (!tx.serializedTx || tx.data !== undefined || tx.to !== undefined) return "a Solana source carries a serialized transaction only";
    // The static part of a bridge (see solanaBridgeTxMismatch); the account proves a Mayan order's recipient (bridgeOut).
    return fromChain === toChain ? null : solanaBridgeTxMismatch(tx.serializedTx, params.refundAddress || (params.dry !== false ? SOLANA_PLACEHOLDER : ""));
  }
  if (!isHexData(tx.data) || !tx.to || tx.serializedTx !== undefined) return "the quote carries no Diamond call";
  if (!sameAddress(tx.to, diamondFor(params.sourceChain))) return `the call targets ${tx.to}, not the LI.FI Diamond`;
  if (tx.chainId !== undefined && String(tx.chainId) !== fromChain) return `the call is for chain ${tx.chainId}, not ${fromChain}`;
  const fromToken = lifiToken(params);
  if (!fromToken) return `unknown source token ${params.sourceToken}`;
  const sourceIsToken = fromToken !== EVM_ZERO;
  // The same addresses the provider quotes for: a dry quote without them prices the placeholder (never built).
  const dry = params.dry !== false;
  const fromAddress = params.refundAddress || (dry ? EVM_PLACEHOLDER : "");
  const toAddress = params.destAddress || (dry ? dryRecipient(params, fromAddress) : "");
  if (!fromAddress || !toAddress) return "a live quote needs the sender and the recipient";
  let amountIn: bigint, minOut: bigint, value: bigint, nativeFee: bigint;
  try {
    amountIn = BigInt(params.amountIn);
    minOut = BigInt(quote.minDestAmount);
    value = BigInt(tx.value ?? "0");
    nativeFee = BigInt(tx.nativeFee ?? "0");
  } catch {
    return "the quote's amounts are not integers";
  }
  if (BigInt(quote.sourceAmount) !== amountIn) return `the quote spends ${quote.sourceAmount}, not the ${amountIn} input`;
  if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) return `the quoted minimum ${minOut} is below the caller's floor ${params.minAmountOut}`;
  if (sourceIsToken) {
    if (value !== nativeFee) return "a token input attaches only its declared bridge fee";
    if (!tx.approvalAddress || !sameAddress(tx.approvalAddress, diamondFor(params.sourceChain))) return "a token input approves the LI.FI Diamond";
  } else {
    if (value < amountIn || value - amountIn !== nativeFee) return "a native input is paid as the input plus its declared bridge fee";
    if (tx.approvalAddress !== undefined) return "a native input approves nothing";
  }
  if (quote.intentId.replace(/~[0-9a-f]{32}$/, "") !== `lifi:${fromChain}:${toChain}`) return "the intent id does not name this route";
  const why = diamondCallMismatch(tx.data, {
    fromToken, toToken: nativeFor(params.destChain, params.destToken), amountIn, receiver: toAddress, sender: fromAddress, minOut,
    destChainId: BigInt(toChain), sameChain: fromChain === toChain, evmDestination: !isSolana(params.destChain),
  });
  return why ? `the transaction does not match the request: ${why}` : null;
}

/**
 * A dry quote with no transaction (priced for a placeholder): what it spends, its minimum against the caller's floor and
 * the route its intent id names are still held to the request; it pays no deposit address, and the bridge fee it declares
 * (`providerData.nativeFee`, which the router nets out of its value) is a base-unit integer. The reason, or null.
 */
function priceOnlyMismatch(params: QuoteParams, quote: Quote, route: string): string | null {
  if (quote.depositAddress !== "") return `a LI.FI quote pays no deposit address, but this one names ${String(quote.depositAddress).slice(0, 64)}`;
  const fee = quote.providerData?.nativeFee;
  if (fee !== undefined && !/^\d{1,80}$/.test(String(fee))) return `the price-only quote declares a native fee of ${String(fee).slice(0, 40)}, not a base-unit integer`;
  try {
    if (BigInt(quote.sourceAmount) !== BigInt(params.amountIn)) return `the quote spends ${quote.sourceAmount}, not the ${params.amountIn} input`;
    const minOut = BigInt(quote.minDestAmount);
    if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) return `the quoted minimum ${minOut} is below the caller's floor ${params.minAmountOut}`;
  } catch {
    return "the quote's amounts are not integers";
  }
  return quote.intentId.replace(/~[0-9a-f]{32}$/, "") === route ? null : "the intent id does not name this route";
}

/**
 * The LI.FI Diamond an EVM route calls and approves on a chain (the canonical one, or the chain's own
 * where it differs), and {@link lifiVerifyQuote} — the app's pins for `remoteProvider({name: "lifi", baseUrl,
 * ...lifiPins})` (scan 2026-10-27 modules, F8/F16; the Diamond call itself since scan 2026-10-30, F3). Extra audited
 * targets an app configures on the provider (`trustedTransactionTargets` / `trustedApprovalAddresses`) are added on
 * the app side too.
 */
export const lifiPins: RemotePins = Object.freeze({
  callTargets: (chain: string): readonly string[] => (/^eip155:[0-9]+$/.test(chain) ? [diamondFor(chain)] : []),
  spenders: (chain: string): readonly string[] => (/^eip155:[0-9]+$/.test(chain) ? [diamondFor(chain)] : []),
  verifyQuote: lifiVerifyQuote,
});
