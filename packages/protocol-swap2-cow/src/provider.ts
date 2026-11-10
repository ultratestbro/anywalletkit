import {concat, decodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, stringToHex, type Hex} from "viem";
import {evmRef, isEvm, sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {describeCowActivity} from "./activity.js";
import {cowApi, CowApiError, type CowApi, type CowApiConfig} from "./api.js";
import {buildAppData, type CowAppData} from "./appdata.js";
import {COW_NATIVE, cowDeployments, deploymentOf, type CowDeployment} from "./deployments.js";
import {
  ETH_FLOW_CREATE_GAS,
  ETH_FLOW_INVALIDATE_GAS,
  ETH_FLOW_INVALIDATED_OWNER,
  decodeEthFlowCall,
  encodeCreateOrder,
  encodeInvalidateOrder,
  encodeOrdersRead,
  ethFlowOrderId,
  packEthFlowData,
  unpackEthFlowData,
  type EthFlowData,
} from "./ethflow.js";
import {cancellationDigest, cancellationTypedData, isOrderUid, orderDigest, orderTypedData, orderUid, rawOrderDigest, splitOrderUid, type CowOrder} from "./order.js";
import {
  COW_PERMIT_HOOK_GAS,
  canonicalSignature,
  detectPermit,
  encodePermitCall,
  permitDigest,
  permitTypedData,
  placeholderPermitCall,
  signedBy,
  simulatePermit,
  type PermitRequest,
} from "./permit.js";
import {cowRpc, type CowRpc} from "./rpc.js";

/**
 * CoW Protocol (docs.cow.fi) as a same-chain swap2 provider on Ethereum, Base and Arbitrum.
 *
 * A CoW swap is an order, not a transaction: the account signs what it sells, the least it accepts, who receives
 * it and until when; solvers compete to fill it and pay the gas. Two ways in:
 *
 * - **ERC-20 sell** — the account signs the order as EIP-712 typed data (never a bare digest) and the provider
 *   posts it to the orderbook. The sell token's allowance for the vault relayer comes from an EIP-2612 permit
 *   carried in the order where the token has one (no transaction at all), from an approval transaction otherwise.
 * - **Native-coin sell** — one transaction to CoWSwapEthFlow, `createOrder` with the input as its value; the
 *   contract places the order. An order that did not fill returns the coin to the sender.
 *
 * Nothing the orderbook answers is signed as it came: the order is written here from the caller's request — the
 * tokens, the receiver, the input, the minimum at the quoted slippage, a zero fee, a fill-or-kill sell with ERC-20
 * balances, this module's own appData document — and the answer only supplies the price and the expiry, both
 * bounded. The contracts are constants (`deployments.ts`), the engine binds the signed struct once more.
 *
 * The orderbook is the public one, called from the device: no key, no server of ours in between. No partner fee.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const DEFAULT_SLIPPAGE_BPS = 50;
/** An order trades for 20 minutes unless the caller's config says otherwise. */
const DEFAULT_VALID_FOR_SECONDS = 1200;
/** How long a quote may be executed after it was priced (the orderbook's own lifetime of a quote is about as long). */
const QUOTE_TTL_MS = 120_000;
/** The orderbook stamps `validTo` from its clock; the device accepts it this far from its own. */
const CLOCK_TOLERANCE_SECONDS = 300;
/** The least life an order has left when it is signed or sent. */
const MIN_HEADROOM_SECONDS = 300;
/** After an eth-flow order expired, CoW's refunder is given this long before the user is asked to refund by hand. */
const REFUND_GRACE_SECONDS = 600;
/** An order the orderbook does not list yet is waited for this long past its expiry. */
const UNKNOWN_ORDER_GRACE_SECONDS = 60;
const SETTLEMENT_INVALIDATE_GAS = 80_000n;
/** Typed-order quotes this instance can still build (a quote lives two minutes). */
const MAX_CONTEXTS = 64;
/** A token whose signed permit was refused is not offered one again for this long. */
const PERMIT_BACKOFF_MS = 600_000;
/** Open orders of the account read to size the allowance (one page). */
const OPEN_ORDERS_PAGE = 100;
/** Other open orders counted into the allowance; an account with more gets no permit and the first ones' total. */
const MAX_COUNTED_ORDERS = 16;
const MAX_ALLOWANCE = (1n << 255n) - 1n;
/** Eth-flow keys an order by its GPv2 digest: an identical order is told apart by a slightly higher minimum. */
const MAX_COLLISION_STEPS = 8;

const READ_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function filledAmount(bytes orderUid) view returns (uint256)",
  "function invalidateOrder(bytes orderUid)",
]);
export interface CowProviderConfig extends CowApiConfig {
  /**
   * Master switch. **Default off**: the module ships dark and an app turns it on (`COW_ENABLED`) chain by chain.
   * Cancelling an order placed earlier works while it is off.
   */
  enabled?: boolean;
  /** The chains offered, by EVM chain id. Default: every chain of the deployment table. */
  enabledChains?: readonly number[];
  /** `appCode` of the orders' appData document (how CoW's explorer names the app). Default "AnyWalletKit". */
  appCode?: string;
  /**
   * JSON-RPC endpoints per EVM chain id, tried in order. Optional — without them the module still quotes, signs
   * and tracks through the orderbook; with them it also offers the gasless permit, reads eth-flow orders from the
   * contract (status and refunds while the orderbook is down) and checks a native payout's receiver.
   */
  rpcUrls?: Readonly<Record<number, readonly string[]>>;
  /** Slippage when the caller names none (bps). Default 50. */
  defaultSlippageBps?: number;
  /** How long an order trades, seconds (120..1500). Default 1200 — 20 minutes. */
  validForSeconds?: number;
  /** Offer the EIP-2612 permit where the token has one. Default true; false always takes the approval transaction. */
  permit?: boolean;
  /** Chains CoW added after this release — see `cowDeployments`. */
  chains?: Readonly<Record<number, CowDeployment>>;
  /** The clock, unix milliseconds (tests). */
  now?: () => number;
}

/** What `readQuoteResponse` checks the orderbook's answer against — the request as this module wrote it. */
export interface CowQuoteExpectation {
  sellToken: string;
  buyToken: string;
  receiver: string;
  from: string;
  signingScheme: "eip712" | "eip1271";
  appData: CowAppData;
  /** The whole input, base units. */
  amountIn: string;
  validForSeconds: number;
  /** The device's clock, unix seconds. */
  nowSeconds: number;
}

/** The parts of a quote this module uses, each checked. */
export interface CowQuoted {
  /** Input left after the solver's network cost. */
  sellAmount: bigint;
  /** What the quoted price pays for it. */
  buyAmount: bigint;
  /** The network cost, in the sell token. `sellAmount + feeAmount` is the input. */
  feeAmount: bigint;
  validTo: number;
  /** The orderbook's id of the quote, when it stored one. */
  id: number | null;
  expirationMs: number;
  /** The orderbook simulated the trade from this account's balances. */
  verified: boolean;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `2026-11-10T09:14:02.123456789Z` → unix ms, without `Date.parse` (Hermes reads only millisecond precision). */
export function isoToMs(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(text);
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, m[7] ? Math.floor(+`0.${m[7]}` * 1000) : 0);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The orderbook's answer to a quote request, field by field against the request. Throws on anything that is not
 * the answer to *this* request: other tokens, receiver or account, another kind of order, another appData
 * document, amounts that do not add up to the input, an expiry the device's clock does not agree with.
 */
export function readQuoteResponse(raw: unknown, expect: CowQuoteExpectation): CowQuoted {
  const bad = (what: string): never => {
    throw new Error(`cow: the orderbook's quote ${what}`);
  };
  if (!raw || typeof raw !== "object") bad("is malformed");
  const r = raw as Record<string, unknown>;
  const q = r.quote && typeof r.quote === "object" ? (r.quote as Record<string, unknown>) : bad("is malformed");
  const address = (v: unknown): string => (typeof v === "string" && ADDRESS.test(v) ? v : "");
  if (!same(address(q.sellToken), expect.sellToken)) bad("sells another token");
  if (!same(address(q.buyToken), expect.buyToken)) bad("buys another token");
  if (!same(address(q.receiver), expect.receiver)) bad("pays another receiver");
  if (!same(address(r.from), expect.from)) bad("is for another account");
  if (q.kind !== "sell") bad("is not a sell order");
  if (q.partiallyFillable !== false) bad("is partially fillable");
  if (q.sellTokenBalance !== "erc20" || q.buyTokenBalance !== "erc20") bad("uses vault balances");
  if (q.signingScheme !== expect.signingScheme) bad("names another signing scheme");
  if (typeof q.appDataHash !== "string" || !same(q.appDataHash, expect.appData.hash)) bad("was priced for another appData document");
  if (q.appData !== expect.appData.json && !(typeof q.appData === "string" && same(q.appData, expect.appData.hash))) bad("was priced for another appData document");
  const amount = (v: unknown): bigint => (typeof v === "string" && DECIMAL.test(v) ? BigInt(v) : bad("has a malformed amount"));
  const sellAmount = amount(q.sellAmount);
  const buyAmount = amount(q.buyAmount);
  const feeAmount = amount(q.feeAmount);
  if (sellAmount <= 0n || buyAmount <= 0n) bad("has a zero amount");
  if (sellAmount + feeAmount !== BigInt(expect.amountIn)) bad("does not add up to the input");
  const validTo = typeof q.validTo === "number" && Number.isInteger(q.validTo) && q.validTo > 0 && q.validTo < 0xffffffff ? q.validTo : bad("has a malformed expiry");
  if (Math.abs(validTo - (expect.nowSeconds + expect.validForSeconds)) > CLOCK_TOLERANCE_SECONDS) bad("expires at another time than requested (check the device clock)");
  const id = r.id === undefined || r.id === null ? null : typeof r.id === "number" && Number.isSafeInteger(r.id) && r.id >= 0 ? r.id : bad("has a malformed id");
  const expirationMs = isoToMs(r.expiration) ?? bad("has a malformed expiration");
  if (expirationMs <= expect.nowSeconds * 1000) bad("has expired already");
  return {sellAmount, buyAmount, feeAmount, validTo, id, expirationMs, verified: r.verified === true};
}

/** A status id of this provider, parsed. */
export type CowIntent =
  /** A typed-order quote this instance priced (lives in memory until it is placed). */
  | {kind: "quote"; chainId: number; key: string}
  /** An order the orderbook accepted. */
  | {kind: "order"; chainId: number; uid: string}
  /** An eth-flow order: its data rides in the id, so a refund needs nothing else. */
  | {kind: "ethflow"; chainId: number; data: EthFlowData};

/** `q:<chain>:<key>` · `o:<chain>:<uid>` · `e:<chain>:<packed eth-flow data>`; null for anything else. */
export function parseCowIntent(intentId: string): CowIntent | null {
  const m = /^([qoe]):([1-9][0-9]{0,15}):([0-9A-Za-z-]{1,300})$/.exec(typeof intentId === "string" ? intentId : "");
  if (!m) return null;
  const chainId = parseInt(m[2]!, 10);
  if (!Number.isSafeInteger(chainId)) return null;
  if (m[1] === "q") return {kind: "quote", chainId, key: m[3]!};
  if (m[1] === "o") return isOrderUid(m[3]) ? {kind: "order", chainId, uid: m[3].toLowerCase()} : null;
  const data = unpackEthFlowData(m[3]!);
  return data ? {kind: "ethflow", chainId, data} : null;
}

/** A typed-order quote between `getQuote` and `registerSignedOrder`. */
interface OrderContext {
  deployment: CowDeployment;
  owner: string;
  token: string;
  /** The order with the appData document that has no hook. */
  order: CowOrder;
  doc: CowAppData;
  slippageBps: number;
  quoteId: number | null;
  /** The quote was priced with a permit hook in its appData. */
  quotedWithHook: boolean;
  approvalAmount: string;
  permit?: PermitRequest;
  /** After `applyPermit`: the order whose appData carries the signed permit. */
  funded?: {order: CowOrder; doc: CowAppData};
  /** The UID once the orderbook accepted the order. */
  placed?: string;
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^cow: /, "").slice(0, 200);

export function cowProvider(config: CowProviderConfig = {}): CrossChainProvider {
  const deployments = cowDeployments(config.chains);
  const api: CowApi = cowApi(config);
  const rpc: CowRpc = cowRpc(config.rpcUrls);
  const now = config.now ?? Date.now;
  const nowSeconds = (): number => Math.floor(now() / 1000);
  const validFor = config.validForSeconds ?? DEFAULT_VALID_FOR_SECONDS;
  if (!Number.isInteger(validFor) || validFor < 120 || validFor > 1500) throw new Error("cow: validForSeconds must be 120..1500");
  const defaultSlippage = config.defaultSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(defaultSlippage) || defaultSlippage < 0 || defaultSlippage >= 5_000) throw new Error("cow: defaultSlippageBps must be 0..4999");
  // Fails here, not at the first quote, when the app code cannot be written into a document.
  buildAppData({...(config.appCode !== undefined ? {appCode: config.appCode} : {}), slippageBps: defaultSlippage});
  const offered = config.enabledChains ? new Set(config.enabledChains) : null;

  const contexts = new Map<string, OrderContext>();
  const permitRefused = new Map<string, number>();
  let counter = 0;

  /** The deployment of a chain this module knows — whether or not the app offers it (orders placed earlier stay reachable). */
  const knownChain = (chainId: number): CowDeployment | null => deploymentOf(deployments, chainId);
  /** The deployment of a chain the app offers for new swaps. */
  const offeredChain = (caip2: string): CowDeployment | null => {
    if (!isEvm(caip2)) return null;
    const id = evmRef(caip2);
    return offered && !offered.has(id) ? null : knownChain(id);
  };
  const appDataOf = (slippageBps: number, permitHook?: {target: string; callData: string}): CowAppData =>
    buildAppData({
      ...(config.appCode !== undefined ? {appCode: config.appCode} : {}),
      slippageBps,
      ...(permitHook ? {permitHook: {...permitHook, gasLimit: COW_PERMIT_HOOK_GAS.toString()}} : {}),
    });

  function remember(key: string, ctx: OrderContext): void {
    const t = nowSeconds();
    for (const [k, c] of contexts) if (c.order.validTo < t) contexts.delete(k);
    while (contexts.size >= MAX_CONTEXTS) contexts.delete(contexts.keys().next().value as string);
    contexts.set(key, ctx);
  }
  function contextOf(intentId: string): OrderContext {
    const ctx = contexts.get(intentId);
    if (!ctx) throw new Error("cow: this quote is no longer known to the provider — request a fresh quote");
    return ctx;
  }

  // ── on-chain reads (all optional) ─────────────────────────────────────────────────────────────

  async function uintRead(chainId: number, to: string, data: Hex): Promise<bigint> {
    const out = await rpc.call(chainId, to, data);
    if (!BYTES32.test(out)) throw new Error("cow: malformed contract answer");
    return BigInt(out);
  }
  /** `orders[digest]` of eth-flow: the address that created the order (zero when there is none) and its expiry. */
  async function ethFlowOwner(d: CowDeployment, digest: string): Promise<{owner: string; validTo: number}> {
    const out = await rpc.call(d.chainId, d.ethFlow, encodeOrdersRead(digest));
    const [owner, validTo] = decodeAbiParameters([{type: "address"}, {type: "uint32"}], out as Hex);
    return {owner: owner.toLowerCase(), validTo};
  }
  const filledAmount = (d: CowDeployment, uid: string): Promise<bigint> =>
    uintRead(d.chainId, d.settlement, encodeFunctionData({abi: READ_ABI, functionName: "filledAmount", args: [uid as Hex]}));

  // ── the account's other open orders of the sell token ─────────────────────────────────────────

  /**
   * What the account's open orders of `token` may still pull through the vault relayer. Only orders the account
   * provably signed are counted — the listed fields must hash to the listed UID and the listed signature must be
   * the account's — so the orderbook cannot talk the allowance up. `known` is false when the list could not be
   * read or may be incomplete: the allowance then covers this order alone and no permit is offered.
   */
  async function openOrders(d: CowDeployment, owner: string, token: string): Promise<{known: boolean; total: bigint; count: number}> {
    let page: unknown[];
    try {
      page = await api.accountOrders(d.network, owner, OPEN_ORDERS_PAGE);
    } catch {
      return {known: false, total: 0n, count: 0};
    }
    const t = nowSeconds();
    let total = 0n;
    let count = 0;
    let known = page.length < OPEN_ORDERS_PAGE;
    for (const entry of page) {
      if (!entry || typeof entry !== "object") continue;
      const o = entry as Record<string, unknown>;
      if (o.status !== "open" || o.invalidated === true) continue;
      if (typeof o.sellToken !== "string" || !ADDRESS.test(o.sellToken) || !same(o.sellToken, token)) continue;
      if (typeof o.validTo !== "number" || !Number.isInteger(o.validTo) || o.validTo <= t || o.validTo > 0xffffffff) continue;
      if (count >= MAX_COUNTED_ORDERS) {
        known = false;
        break;
      }
      try {
        const text = (v: unknown): string => (typeof v === "string" ? v : "");
        const amount = (v: unknown): string => (typeof v === "string" && DECIMAL.test(v) ? v : "x");
        const uid = text(o.uid);
        const parts = splitOrderUid(uid);
        const digest = rawOrderDigest(d.chainId, {
          sellToken: o.sellToken,
          buyToken: text(o.buyToken),
          receiver: o.receiver === null || o.receiver === undefined ? null : text(o.receiver),
          sellAmount: amount(o.sellAmount),
          buyAmount: amount(o.buyAmount),
          validTo: o.validTo,
          appData: BYTES32.test(text(o.appData)) ? text(o.appData) : "x",
          feeAmount: amount(o.feeAmount),
          kind: text(o.kind),
          partiallyFillable: o.partiallyFillable === true,
          sellTokenBalance: text(o.sellTokenBalance),
          buyTokenBalance: text(o.buyTokenBalance),
        });
        if (digest !== parts.digest || !same(parts.owner, owner) || parts.validTo !== o.validTo) continue;
        const signed = o.signingScheme === "eip712"
          ? await signedBy(digest, text(o.signature), owner)
          : o.signingScheme === "ethsign"
            ? await signedBy(keccak256(concat([stringToHex("\x19Ethereum Signed Message:\n32"), digest])), text(o.signature), owner)
            : false;
        if (!signed) continue;
        const executed = typeof o.executedSellAmount === "string" && DECIMAL.test(o.executedSellAmount) ? BigInt(o.executedSellAmount) : 0n;
        const left = BigInt(amount(o.sellAmount)) + BigInt(amount(o.feeAmount)) - executed;
        if (left > 0n) {
          total += left;
          count++;
        }
      } catch {
        // an entry that does not parse proves nothing: not counted
      }
    }
    return {known, total, count};
  }

  // ── quoting ───────────────────────────────────────────────────────────────────────────────────

  async function quoted(d: CowDeployment, expect: CowQuoteExpectation, ethFlow: boolean, signal?: AbortSignal): Promise<CowQuoted> {
    const body = (priceQuality: "verified" | "optimal") => ({
      sellToken: expect.sellToken.toLowerCase(),
      buyToken: expect.buyToken.toLowerCase(),
      receiver: expect.receiver.toLowerCase(),
      from: expect.from.toLowerCase(),
      kind: "sell",
      sellAmountBeforeFee: expect.amountIn,
      priceQuality,
      signingScheme: expect.signingScheme,
      ...(ethFlow ? {onchainOrder: true} : {}),
      validFor: expect.validForSeconds,
      appData: expect.appData.json,
      appDataHash: expect.appData.hash,
    });
    let raw: unknown;
    try {
      raw = await api.quote(d.network, body("verified"), signal);
    } catch (e) {
      // An account that does not hold the input yet cannot be simulated: the price is still a price. The quote
      // says so (`providerData.verified`), the app decides how loudly to show it.
      if (!(e instanceof CowApiError) || e.errorType !== "QuoteNotVerified") throw e;
      raw = await api.quote(d.network, body("optimal"), signal);
    }
    return readQuoteResponse(raw, expect);
  }

  const provider: CrossChainProvider = {
    name: "cow",
    describeActivity: describeCowActivity,
    supportsSameChain: true,
    enabled: () => config.enabled ?? false,
    supportsChain: (caip2) => !!offeredChain(caip2),
    supportsChainPair: (fromChain, toChain) => fromChain === toChain && !!offeredChain(fromChain),
    supportsRoute: (from: Asset, to: Asset) => from.chain === to.chain && !!offeredChain(from.chain),

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (why: string): null => {
        params.onRefusal?.(`cow: ${why}`);
        return null;
      };
      if (params.flex) return refuse("amount-flexible deposits are not supported");
      if (params.sourceChain !== params.destChain) return refuse("CoW Protocol swaps stay on one chain");
      const d = offeredChain(params.sourceChain);
      if (!d) return refuse(`${params.sourceChain} is not offered`);
      const source = sourceAssetOf(params);
      if (!source) return refuse(`unknown source token '${params.sourceToken}'`);
      const sellNative = !source.contract;
      if (!sellNative && !ADDRESS.test(source.contract!)) return refuse("the source token is not an EVM token");
      if (!ADDRESS.test(params.destToken)) return refuse("the destination token is not an EVM token");
      const buyNative = /^0x0{40}$/.test(params.destToken) || same(params.destToken, COW_NATIVE);
      const sellToken = getAddress(sellNative ? d.wrappedNative : source.contract!);
      const buyToken = buyNative ? COW_NATIVE : getAddress(params.destToken);
      if (same(sellToken, COW_NATIVE) || same(sellToken, ZERO)) return refuse("the native coin is sold through eth-flow, not as a token");
      if (sellNative && buyNative) return refuse("same token in and out");
      if (sellNative && same(buyToken, d.wrappedNative)) return refuse("wrapping the native coin is not a swap");
      if (!sellNative && same(sellToken, d.wrappedNative) && buyNative) return refuse("unwrapping the native coin is not a swap");
      if (same(sellToken, buyToken)) return refuse("same token in and out");
      if (!DECIMAL.test(params.amountIn) || BigInt(params.amountIn) <= 0n) return refuse("the amount must be a positive whole number of base units");
      const slippageBps = params.slippageBps ?? defaultSlippage;
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) return refuse("slippage must be whole basis points below 10000");

      const valid = (a: string | undefined): a is string => typeof a === "string" && ADDRESS.test(a) && !/^0x0{40}$/.test(a);
      if (!valid(params.destAddress) && !valid(params.refundAddress)) return refuse("recipient must be an EVM address");
      // The account that signs (or sends) is where a failed swap refunds; the receiver is the recipient the caller named.
      const owner = getAddress(valid(params.refundAddress) ? params.refundAddress : params.destAddress);
      const receiver = getAddress(valid(params.destAddress) ? params.destAddress : owner);
      const t = nowSeconds();

      try {
        // A settlement pays the native coin with a plain transfer: an address with code may not be able to take it.
        if (buyNative && rpc.has(d.chainId)) {
          const code = await rpc.request(d.chainId, "eth_getCode", [receiver, "latest"]).catch(() => "0x");
          if (typeof code === "string" && code !== "0x" && code !== "0x0") return refuse("the receiver is a contract and may not accept the native coin from a settlement — receive the wrapped token instead");
        }
        const plain = appDataOf(slippageBps);
        const floorOf = (buyAmount: bigint): bigint | null => {
          let min = buyAmount - (buyAmount * BigInt(slippageBps)) / 10_000n;
          if (params.minAmountOut !== undefined) {
            if (!DECIMAL.test(params.minAmountOut)) return null;
            const floor = BigInt(params.minAmountOut);
            if (floor > buyAmount) return null;
            // The caller's own floor is a tighter limit price than the slippage's: the order signs it.
            if (floor > min) min = floor;
          }
          return min > 0n ? min : null;
        };
        const common = (q: CowQuoted, min: bigint, kind: string, extra: Record<string, string> = {}) => ({
          provider: "cow",
          depositAddress: "",
          depositMemo: null,
          sourceAmount: params.amountIn,
          destAmount: q.buyAmount.toString(),
          minDestAmount: min.toString(),
          feeUsd: 0,
          fees: [{
            type: "network" as const,
            amount: q.feeAmount.toString(),
            token: source.contract ?? (source.assetId || "native"),
            included: true,
            description: "Solver network cost — taken from the input, already in the quoted output; no gas is paid for the trade itself",
          }],
          // A batch auction settles within a few blocks once the order is in; an order nobody fills expires unfilled.
          etaSeconds: d.chainId === 1 ? 45 : 30,
          reliability: 0.9,
          validUntilMs: Math.min(q.expirationMs, now() + QUOTE_TTL_MS),
          providerData: {
            kind,
            verified: q.verified ? "true" : "false",
            validTo: String(q.validTo),
            slippageBps: String(slippageBps),
            owner,
            ...(q.id !== null ? {quoteId: String(q.id)} : {}),
            ...extra,
          },
        });

        if (sellNative) {
          const q = await quoted(d, {sellToken, buyToken, receiver, from: owner, signingScheme: "eip1271", appData: plain, amountIn: params.amountIn, validForSeconds: validFor, nowSeconds: t}, true, signal);
          if (q.id === null) return refuse("the orderbook returned no quote id for an on-chain order");
          const floor = floorOf(q.buyAmount);
          if (floor === null) return refuse("the quote is below the requested minimum");
          let data: EthFlowData = {buyToken, receiver, sellAmount: params.amountIn, buyAmount: floor.toString(), appData: plain.hash, validTo: q.validTo, quoteId: q.id};
          if (!params.dry && rpc.has(d.chainId)) {
            // The contract holds one order per digest, and the digest ignores the expiry and the quote id: the same
            // swap asked twice would collide (also after the first was refunded). One more unit of minimum tells them apart.
            for (let step = 0; ; step++) {
              let taken: boolean;
              try {
                taken = !/^0x0{40}$/.test((await ethFlowOwner(d, ethFlowOrderId(d, data).digest)).owner);
              } catch {
                break; // unreadable: the preflight reads it again, and the contract refuses a duplicate anyway
              }
              if (!taken) break;
              const next = BigInt(data.buyAmount) + 1n;
              if (step >= MAX_COLLISION_STEPS || next > q.buyAmount) return refuse("an identical order was placed already — change the amount slightly");
              data = {...data, buyAmount: next.toString()};
            }
          }
          return {
            ...common(q, BigInt(data.buyAmount), "ethflow", {appData: plain.hash}),
            intentId: `e:${d.chainId}:${packEthFlowData(data)}`,
            txRequest: {to: d.ethFlow, data: encodeCreateOrder(data), value: params.amountIn, chainId: d.chainId, gasLimit: ETH_FLOW_CREATE_GAS.toString()},
          };
        }

        // ERC-20 sell. What the vault relayer must be allowed, and whether a permit can give it.
        let approvalAmount = BigInt(params.amountIn);
        let permit: PermitRequest | undefined;
        let quoteDoc = plain;
        if (!params.dry) {
          const others = await openOrders(d, owner, sellToken);
          if (approvalAmount + others.total <= MAX_ALLOWANCE) approvalAmount += others.total;
          const backoff = permitRefused.get(`${d.chainId}:${sellToken.toLowerCase()}`) ?? 0;
          if (config.permit !== false && rpc.has(d.chainId) && others.known && others.count === 0 && backoff <= now()) {
            const allowance = await uintRead(d.chainId, sellToken, encodeFunctionData({abi: READ_ABI, functionName: "allowance", args: [owner, getAddress(d.vaultRelayer)]})).catch(() => null);
            if (allowance !== null && allowance < approvalAmount) {
              const found = await detectPermit(rpc, d.chainId, sellToken, owner);
              if (found) {
                // The deadline is the order's expiry, known only from the answer: the quote is priced with a hook of
                // the same shape, the permit itself is written once the expiry is.
                quoteDoc = appDataOf(slippageBps, {target: sellToken, callData: placeholderPermitCall({owner, value: approvalAmount.toString(), deadline: t + validFor})});
                permit = {chainId: d.chainId, token: sellToken, domain: found.domain, owner, value: approvalAmount.toString(), nonce: found.nonce, deadline: 0};
              }
            }
          }
        }
        const q = await quoted(d, {sellToken, buyToken, receiver, from: owner, signingScheme: "eip712", appData: quoteDoc, amountIn: params.amountIn, validForSeconds: validFor, nowSeconds: t}, false, signal);
        const floor = floorOf(q.buyAmount);
        if (floor === null) return refuse("the quote is below the requested minimum");
        const order: CowOrder = {
          sellToken,
          buyToken,
          receiver,
          sellAmount: params.amountIn,
          buyAmount: floor.toString(),
          validTo: q.validTo,
          appData: plain.hash,
          feeAmount: "0",
          kind: "sell",
          partiallyFillable: false,
          sellTokenBalance: "erc20",
          buyTokenBalance: "erc20",
        };
        const intentId = `q:${d.chainId}:${(++counter).toString(36)}-${now().toString(36)}`;
        if (!params.dry) {
          remember(intentId, {
            deployment: d,
            owner,
            token: sellToken,
            order,
            doc: plain,
            slippageBps,
            quoteId: q.id,
            quotedWithHook: quoteDoc !== plain,
            approvalAmount: approvalAmount.toString(),
            ...(permit ? {permit: {...permit, deadline: q.validTo}} : {}),
          });
        }
        return {...common(q, floor, "order", {appData: plain.hash, permit: permit ? "offered" : "none"}), intentId};
      } catch (e) {
        return refuse(reasonOf(e));
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const intent = parseCowIntent(quote.intentId);
      if (!intent) throw new Error("cow: this is not a CoW quote");
      const d = knownChain(intent.chainId);
      if (!d) throw new Error(`cow: chain ${intent.chainId} is not a CoW Protocol chain of this module`);
      const chain = `eip155:${d.chainId}`;
      if (intent.kind === "ethflow") {
        // The transaction is written again from the order data in the id; the engine then holds it to the quote's.
        const data = encodeCreateOrder(intent.data);
        if (quote.sourceAmount !== intent.data.sellAmount || BigInt(quote.minDestAmount) !== BigInt(intent.data.buyAmount)) throw new Error("cow: the quote does not match its eth-flow order");
        return {chain, to: d.ethFlow, value: intent.data.sellAmount, data, chainId: d.chainId, gasLimit: ETH_FLOW_CREATE_GAS.toString()};
      }
      if (intent.kind !== "quote") throw new Error("cow: this order was placed already");
      const ctx = contextOf(quote.intentId);
      if (quote.sourceAmount !== ctx.order.sellAmount || quote.minDestAmount !== ctx.order.buyAmount) throw new Error("cow: the quote does not match its order");
      return {
        chain,
        to: d.settlement,
        value: "0",
        chainId: d.chainId,
        approvalAddress: d.vaultRelayer,
        typedData: JSON.stringify(orderTypedData(d.chainId, ctx.order)),
        approvalAmount: ctx.approvalAmount,
        ...(ctx.permit ? {permit: JSON.stringify(permitTypedData(ctx.permit))} : {}),
      };
    },

    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const intent = parseCowIntent(quote.intentId);
      if (!intent) throw new Error("cow: this is not a CoW quote");
      const d = knownChain(intent.chainId);
      if (!d) throw new Error(`cow: chain ${intent.chainId} is not a CoW Protocol chain of this module`);
      const tooLate = (validTo: number) => {
        if (validTo - nowSeconds() < MIN_HEADROOM_SECONDS) throw new Error("cow: the order would expire too soon to be filled — request a fresh quote");
      };
      if (intent.kind === "quote") {
        tooLate(contextOf(quote.intentId).order.validTo);
        return;
      }
      if (intent.kind !== "ethflow") throw new Error("cow: this order was placed already");
      const call = tx.data ? decodeEthFlowCall(tx.data) : null;
      if (!call || call.method !== "createOrder" || !same(tx.to, d.ethFlow) || packEthFlowData(call.order) !== packEthFlowData(intent.data)) throw new Error("cow: the transaction is not this quote's eth-flow order");
      tooLate(intent.data.validTo);
      if (rpc.has(d.chainId)) {
        const state = await ethFlowOwner(d, ethFlowOrderId(d, intent.data).digest).catch(() => null);
        if (state && !/^0x0{40}$/.test(state.owner)) throw new Error("cow: an identical order was placed already — request a fresh quote");
      }
      // The order is placed by the transaction, so nobody posts its appData document with it: the orderbook must
      // know the document first, or the order is listed without one. Not registered → nothing is sent.
      const slippage = Number(quote.providerData?.slippageBps);
      const doc = appDataOf(Number.isInteger(slippage) ? slippage : -1);
      if (!same(doc.hash, intent.data.appData)) throw new Error("cow: the order's appData is not this provider's document — request a fresh quote");
      await api.putAppData(d.network, doc.hash, doc.json);
    },

    async applyPermit(intentId: string, signature: string): Promise<UnsignedTx> {
      const ctx = contextOf(intentId);
      const d = ctx.deployment;
      if (!ctx.permit) throw new Error("cow: this quote offered no permit");
      if (!(await signedBy(permitDigest(ctx.permit), signature, ctx.owner))) throw new Error("cow: the permit is not signed by the order's account");
      const callData = encodePermitCall(ctx.permit, signature);
      try {
        await simulatePermit(rpc, d.chainId, ctx.token, d.settlement, callData);
      } catch (e) {
        // The token proved EIP-2612 and still refused: the next quote takes the approval transaction.
        permitRefused.set(`${d.chainId}:${ctx.token.toLowerCase()}`, now() + PERMIT_BACKOFF_MS);
        throw e;
      }
      const doc = appDataOf(ctx.slippageBps, {target: ctx.token, callData});
      ctx.funded = {order: {...ctx.order, appData: doc.hash}, doc};
      return {
        chain: `eip155:${d.chainId}`,
        to: d.settlement,
        value: "0",
        chainId: d.chainId,
        approvalAddress: d.vaultRelayer,
        typedData: JSON.stringify(orderTypedData(d.chainId, ctx.funded.order)),
        approvalAmount: ctx.approvalAmount,
      };
    },

    async registerSignedOrder(intentId: string, signature: string): Promise<{intentId: string}> {
      const ctx = contextOf(intentId);
      const d = ctx.deployment;
      const {order, doc} = ctx.funded ?? ctx;
      const digest = orderDigest(d.chainId, order);
      const uid = orderUid(digest, ctx.owner, order.validTo);
      const placedId = {intentId: `o:${d.chainId}:${uid}`};
      if (ctx.placed === uid) return placedId;
      // Only the account's own ECDSA signature over this exact typed order leaves the device.
      const canonical = canonicalSignature(signature);
      if (!canonical || !(await signedBy(digest, canonical, ctx.owner))) throw new Error(`cow: the order is not signed by ${ctx.owner} — only the account that requested the quote can place it`);
      if (order.validTo - nowSeconds() < MIN_HEADROOM_SECONDS) throw new Error("cow: the order would expire too soon to be filled — request a fresh quote");
      // The quote is named only when the order was priced with the same hook gas it now carries.
      const quoteId = ctx.quoteId !== null && ctx.quotedWithHook === !!ctx.funded ? ctx.quoteId : null;
      const body = (withQuote: boolean) => ({
        ...order,
        appData: doc.json,
        appDataHash: doc.hash,
        from: ctx.owner,
        signingScheme: "eip712",
        signature: canonical,
        ...(withQuote && quoteId !== null ? {quoteId} : {}),
      });
      let answer: unknown;
      try {
        try {
          answer = await api.postOrder(d.network, body(true));
        } catch (e) {
          if (quoteId === null || !(e instanceof CowApiError) || (e.errorType !== "QuoteNotFound" && e.errorType !== "InvalidQuote")) throw e;
          answer = await api.postOrder(d.network, body(false));
        }
      } catch (e) {
        // The same order is there already (an earlier attempt whose answer was lost): it is placed.
        if (e instanceof CowApiError && e.errorType === "DuplicatedOrder") {
          ctx.placed = uid;
          return placedId;
        }
        throw e;
      }
      if (typeof answer !== "string" || !same(answer, uid)) throw new Error(`cow: the orderbook answered with another order id than ${uid} — check this order before trying again`);
      ctx.placed = uid;
      return placedId;
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      const intent = parseCowIntent(ref.intentId);
      if (!intent || intent.kind === "quote") return {state: "pending"};
      const d = knownChain(intent.chainId);
      if (!d) return {state: "pending"};
      const chain = `eip155:${d.chainId}`;
      const t = nowSeconds();
      const fillHash = async (uid: string): Promise<{destTxHash?: string}> => {
        try {
          const first = (await api.trades(d.network, uid))[0] as {txHash?: unknown} | undefined;
          return typeof first?.txHash === "string" && TX_HASH.test(first.txHash) ? {destTxHash: first.txHash.toLowerCase()} : {};
        } catch {
          return {};
        }
      };
      const positive = (v: unknown): boolean => typeof v === "string" && DECIMAL.test(v) && BigInt(v) > 0n;

      if (intent.kind === "order") {
        const validTo = splitOrderUid(intent.uid).validTo;
        let order: Record<string, unknown> | null;
        try {
          order = await api.order(d.network, intent.uid);
        } catch {
          // The orderbook is down: the settlement contract still knows whether the order was filled or invalidated.
          if (!rpc.has(d.chainId)) return {state: "pending"};
          const filled = await filledAmount(d, intent.uid).catch(() => null);
          if (filled === null) return {state: "pending"};
          if (filled === (1n << 256n) - 1n) return {state: "cancelled"};
          if (filled > 0n) return {state: "completed"};
          return t > validTo ? {state: "expired"} : {state: "pending"};
        }
        if (!order) return t > validTo + UNKNOWN_ORDER_GRACE_SECONDS ? {state: "expired"} : {state: "pending"};
        if (order.status === "fulfilled" || ((order.status === "cancelled" || order.status === "expired") && positive(order.executedBuyAmount))) {
          return {state: "completed", ...(await fillHash(intent.uid))};
        }
        if (order.status === "cancelled") return {state: "cancelled"};
        if (order.status === "expired") return {state: "expired"};
        return {state: "pending"};
      }

      // Eth-flow: the coin sits in the contract from the transaction until the fill or the refund.
      const data = intent.data;
      const {digest, uid} = ethFlowOrderId(d, data);
      /** Past its expiry and neither filled nor refunded: CoW's refunder first, then the user. */
      const unfilled = (): IntentStatus => (t <= data.validTo + REFUND_GRACE_SECONDS ? {state: "refund-pending"} : {state: "action-required", claim: {chain, ready: true}});
      const onchain = async (): Promise<IntentStatus | null> => {
        if (!rpc.has(d.chainId)) return null;
        try {
          const state = await ethFlowOwner(d, digest);
          if (state.owner === ETH_FLOW_INVALIDATED_OWNER) return {state: "refunded"};
          if (/^0x0{40}$/.test(state.owner)) {
            // No order in the contract: the transaction has not been mined, or it failed.
            if (ref.sourceTxHash && TX_HASH.test(ref.sourceTxHash)) {
              const receipt = (await rpc.request(d.chainId, "eth_getTransactionReceipt", [ref.sourceTxHash])) as {status?: unknown} | null;
              if (receipt && receipt.status === "0x0") return {state: "failed"};
            }
            return t > data.validTo + REFUND_GRACE_SECONDS ? {state: "expired"} : {state: "pending"};
          }
          if ((await filledAmount(d, uid)) > 0n) return {state: "completed"};
          return t <= data.validTo ? {state: "pending", depositReceived: true} : unfilled();
        } catch {
          return null;
        }
      };
      let order: Record<string, unknown> | null;
      try {
        order = await api.order(d.network, uid);
      } catch {
        return (await onchain()) ?? {state: "pending"};
      }
      if (!order) {
        // Not listed (yet): the contract decides when it can be read. Without it, funds may sit in the contract once
        // a transaction was sent — never called expired, the refund stays on offer.
        const known = await onchain();
        if (known) return known;
        if (t <= data.validTo + REFUND_GRACE_SECONDS) return {state: "pending"};
        return ref.sourceTxHash ? {state: "action-required", claim: {chain, ready: true}} : {state: "expired"};
      }
      if (order.status === "fulfilled" || positive(order.executedBuyAmount)) return {state: "completed", ...(await fillHash(uid))};
      const flow = order.ethflowData && typeof order.ethflowData === "object" ? (order.ethflowData as {refundTxHash?: unknown}) : {};
      if (typeof flow.refundTxHash === "string" && TX_HASH.test(flow.refundTxHash)) return {state: "refunded"};
      const placement = order.onchainOrderData && typeof order.onchainOrderData === "object" ? (order.onchainOrderData as {placementError?: unknown}).placementError : null;
      const stuck = typeof placement === "string" && placement.length > 0;
      if (!stuck && order.status === "open" && t <= data.validTo) return {state: "pending", depositReceived: true};
      // Cancelled, expired or refused by the orderbook: refunded already when the contract says so.
      const known = await onchain();
      if (known && (known.state === "refunded" || known.state === "completed")) return known;
      // An order the orderbook refused never trades: its creator takes the coin back right away.
      if (stuck) return {state: "action-required", claim: {chain, ready: true}};
      return unfilled();
    },

    /** The refund of an eth-flow order that did not fill: `invalidateOrder` returns the coin to the address that created it. */
    async buildClaim(ref: IntentRef): Promise<UnsignedTx | null> {
      const intent = parseCowIntent(ref.intentId);
      if (!intent || intent.kind !== "ethflow") return null;
      const d = knownChain(intent.chainId);
      if (!d) return null;
      const data = intent.data;
      const {digest, uid} = ethFlowOrderId(d, data);
      const t = nowSeconds();
      const tx: UnsignedTx = {chain: `eip155:${d.chainId}`, to: d.ethFlow, value: "0", data: encodeInvalidateOrder(data), chainId: d.chainId, gasLimit: ETH_FLOW_INVALIDATE_GAS.toString()};
      if (rpc.has(d.chainId)) {
        try {
          const state = await ethFlowOwner(d, digest);
          if (state.owner === ETH_FLOW_INVALIDATED_OWNER || /^0x0{40}$/.test(state.owner)) return null; // refunded already, or never placed
          if ((await filledAmount(d, uid)) > 0n) return null;
          if (t > data.validTo) return tx;
        } catch {
          // unreadable: the orderbook decides below
        }
      }
      let order: Record<string, unknown> | null = null;
      try {
        order = await api.order(d.network, uid);
      } catch {
        // Neither the contract nor the orderbook answered: after the expiry the refund is still the right call
        // (it reverts, costing nothing but the estimate, when there is nothing to refund).
        return t > data.validTo ? tx : null;
      }
      if (!order) return t > data.validTo ? tx : null;
      if (order.status === "fulfilled") return null;
      const flow = order.ethflowData && typeof order.ethflowData === "object" ? (order.ethflowData as {refundTxHash?: unknown}) : {};
      if (typeof flow.refundTxHash === "string" && TX_HASH.test(flow.refundTxHash)) return null;
      const placement = order.onchainOrderData && typeof order.onchainOrderData === "object" ? (order.onchainOrderData as {placementError?: unknown}).placementError : null;
      if (typeof placement === "string" && placement.length > 0) return tx;
      return t > data.validTo ? tx : null;
    },
    claimTargets: (chain: string) => {
      const d = isEvm(chain) ? knownChain(evmRef(chain)) : null;
      return d ? [d.ethFlow] : [];
    },

    async buildCancel(ref: IntentRef, options: {owner: string; onchain: boolean}): Promise<UnsignedTx | null> {
      const intent = parseCowIntent(ref.intentId);
      if (!intent || intent.kind === "quote") return null;
      const d = knownChain(intent.chainId);
      if (!d) return null;
      const chain = `eip155:${d.chainId}`;
      const t = nowSeconds();
      if (intent.kind === "ethflow") {
        // Placed by a transaction, cancelled by one: the same call that refunds it. While the order can still trade
        // only its creator may call it; the contract checks that.
        const data = intent.data;
        const {digest, uid} = ethFlowOrderId(d, data);
        const tx: UnsignedTx = {chain, to: d.ethFlow, value: "0", data: encodeInvalidateOrder(data), chainId: d.chainId, gasLimit: ETH_FLOW_INVALIDATE_GAS.toString()};
        if (rpc.has(d.chainId)) {
          try {
            const state = await ethFlowOwner(d, digest);
            if (state.owner === ETH_FLOW_INVALIDATED_OWNER || /^0x0{40}$/.test(state.owner)) return null;
            if ((await filledAmount(d, uid)) > 0n) return null;
            if (t <= data.validTo && !same(state.owner, options.owner)) throw new Error("cow: this order was placed by another account — only that account can cancel it before it expires");
            return tx;
          } catch (e) {
            if (e instanceof Error && e.message.startsWith("cow: this order was placed by")) throw e;
          }
        }
        const order = await api.order(d.network, uid).catch(() => null);
        if (order?.status === "fulfilled") return null;
        const flow = order?.ethflowData && typeof order.ethflowData === "object" ? (order.ethflowData as {refundTxHash?: unknown}) : {};
        if (typeof flow.refundTxHash === "string" && TX_HASH.test(flow.refundTxHash)) return null;
        return tx;
      }
      const parts = splitOrderUid(intent.uid);
      if (!same(parts.owner, options.owner)) throw new Error("cow: this order belongs to another account");
      if (t > parts.validTo) return null;
      let order: Record<string, unknown> | null;
      try {
        order = await api.order(d.network, intent.uid);
      } catch (e) {
        // Without the orderbook only the contract can cancel — and it can, whatever the orderbook's state.
        if (!options.onchain) throw e;
        order = {status: "open"};
      }
      if (!order || (order.status !== "open" && order.status !== "presignaturePending")) return null;
      if (options.onchain) {
        return {chain, to: d.settlement, value: "0", data: encodeFunctionData({abi: READ_ABI, functionName: "invalidateOrder", args: [intent.uid as Hex]}), chainId: d.chainId, gasLimit: SETTLEMENT_INVALIDATE_GAS.toString()};
      }
      return {chain, to: d.settlement, value: "0", chainId: d.chainId, typedData: JSON.stringify(cancellationTypedData(d.chainId, [intent.uid]))};
    },

    async registerCancel(intentId: string, signature: string): Promise<void> {
      const intent = parseCowIntent(intentId);
      if (!intent || intent.kind !== "order") throw new Error("cow: only an order in the orderbook can be cancelled off-chain");
      const d = knownChain(intent.chainId);
      if (!d) throw new Error(`cow: chain ${intent.chainId} is not a CoW Protocol chain of this module`);
      const canonical = canonicalSignature(signature);
      if (!canonical || !(await signedBy(cancellationDigest(d.chainId, [intent.uid]), canonical, splitOrderUid(intent.uid).owner))) throw new Error("cow: the cancellation is not signed by the order's account");
      try {
        await api.cancelOrders(d.network, {orderUids: [intent.uid], signature: canonical, signingScheme: "eip712"});
      } catch (e) {
        if (e instanceof CowApiError && e.errorType === "AlreadyCancelled") return;
        throw e;
      }
    },
    cancelTargets: (chain: string) => {
      const d = isEvm(chain) ? knownChain(evmRef(chain)) : null;
      return d ? [d.settlement, d.ethFlow] : [];
    },
  };
  return provider;
}
