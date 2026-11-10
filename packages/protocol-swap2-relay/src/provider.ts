import {anySignal, redactUrls, timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentState, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {describeRelayActivity} from "./activity.js";
import {RELAY_API, relay as relayCfg, relayChain} from "./config.js";
import {RelayRefusal} from "./order.js";
import {RELAY_DEFAULT_SLIPPAGE_BPS, RELAY_GAS_CAP as GAS_CAP, RELAY_GAS_FLOOR_ERC20 as GAS_FLOOR_ERC20, RELAY_GAS_FLOOR_NATIVE as GAS_FLOOR_NATIVE, checkRelayQuote, relayClearOrder, relayRequestOf, verifyRelayOrder, type RelayRequest} from "./verify.js";

/**
 * Relay (relay.link) — a solver network. ONE source transaction: a deposit into the chain's RelayDepository that names
 * an order by its hash; Relay's solver then pays the recipient on the destination chain, or the deposit is refunded.
 *
 *  - Quote = `POST /quote/v2` with `includeProtocolData: true`, which returns the order itself next to the deposit.
 *    The answer is only an input to `verify.ts`: the order is parsed, hashed and attributed on the device, compared
 *    with the request, and the deposit this module builds from its own pins must be byte-for-byte the one offered.
 *    What a quote carries afterwards is that own-built call; the amounts it shows are the order's (`expectedAmount`
 *    as the estimate, `minimumAmount` as the enforced minimum).
 *  - The API's `approve` step is never used: an ERC-20 input sets `approvalAddress` to the pinned depository and the
 *    engine approves exactly the input amount.
 *  - `baseUrl` may be the app's own proxy that adds the API key. It cannot get a deposit signed for another
 *    recipient, chain, token, minimum or refund address than the request's. It CAN make the quote worse: the solver
 *    signs whatever request reaches Relay, so a proxy that adds an app fee or a gas top-up gets a genuine order with
 *    a lower expected amount. The response's own account of such extras is refused (`app-fee`, `gas-topup`), but a
 *    proxy can strip that too — the amounts shown are always the order's, and what bounds the price is the caller's
 *    `minAmountOut` or the other quotes of the router, not this module.
 *  - Routes Relay serves by first swapping on the source chain call a router, not the depository, and are refused
 *    by name (`tx-target`); so are non-EVM chains and any chain without a pin.
 *  - Status: `GET /intents/status/v3?requestId=` — display only, nothing is signed on its word.
 */

const EVM_PLACEHOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const DEFAULT_QUOTE_TTL_MS = 60_000;
const QUOTE_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 12_000;
const INTENT_PREFIX = "relay:";
const REQUEST_ID = /^0x[0-9a-f]{64}$/;
const MAX_BODY = 512 * 1024;
const MAX_REMEMBERED = 256;

export interface RelayProviderConfig {
  enabled?: boolean;
  /**
   * Relay's API (default https://api.relay.link) or the app's own proxy in front of it. Untrusted either way:
   * every answer is verified on the device.
   */
  baseUrl?: string;
  /** Sent as `x-api-key` when set. Prefer a proxy that adds it — a key shipped in an app is public. */
  apiKey?: string;
  /** Local lifetime of a quote (default 60 s, at most 5 min). The order itself is refused once older than 10 min. */
  quoteTtlMs?: number;
  /** Injectable for tests and for runtimes that bring their own. */
  fetchImpl?: typeof fetch;
  /**
   * Where cleared order ids are also kept, so that "one deposit per order" survives an app restart (the built-in
   * record lives in memory). `has` is asked and `add` awaited right before a signature; either throwing refuses.
   */
  clearedStore?: RelayClearedStore;
}

/** A durable record of order ids a deposit was cleared for. `expiresAtMs` is when an entry may be dropped. */
export interface RelayClearedStore {
  has(orderId: string): boolean | Promise<boolean>;
  add(orderId: string, expiresAtMs: number): void | Promise<void>;
}

interface RelayStep {id?: unknown; requestId?: unknown; items?: unknown}
interface RelayQuoteBody {
  steps?: unknown;
  fees?: {relayer?: {currency?: {address?: unknown}; amount?: unknown; amountUsd?: unknown}; app?: {amount?: unknown}};
  details?: {timeEstimate?: unknown; currencyGasTopup?: {amount?: unknown}};
  protocol?: {v2?: unknown};
  message?: unknown;
  errorCode?: unknown;
}

/** Relay's request states → swap2 states. `failure` is read together with `refundFailReason` (see `trackIntent`). */
export const RELAY_STATUS_MAP: Readonly<Record<string, IntentState>> = Object.freeze({
  waiting: "pending", depositing: "pending", pending: "pending", submitted: "pending", delayed: "pending", unknown: "pending",
  success: "completed", refund: "refunded", refunded: "refunded", failure: "refund-pending",
});

function clip(text: string, max = 240): string {
  const t = redactUrls(text).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** The single deposit step of a quote response; an `approve` step is ignored, anything else refuses the quote. */
function depositStep(body: RelayQuoteBody): {requestId: string; tx: {to?: unknown; data?: unknown; value?: unknown; chainId?: unknown; gas?: unknown}} {
  const steps = body.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 8) throw new RelayRefusal("quote-steps", "the quote has no steps");
  let found: RelayStep | null = null;
  for (const s of steps as RelayStep[]) {
    if (s === null || typeof s !== "object") throw new RelayRefusal("quote-steps", "the quote has a malformed step");
    if (s.id === "approve") continue; // never used: the approval is built here, for the exact amount, to the pinned depository
    if (s.id !== "deposit") throw new RelayRefusal("quote-steps", `the quote needs a "${clip(String(s.id), 40)}" step, only a single deposit is signed`);
    if (found) throw new RelayRefusal("quote-steps", "the quote has more than one deposit step");
    found = s;
  }
  if (!found) throw new RelayRefusal("quote-steps", "the quote has no deposit step");
  const items = found.items;
  if (!Array.isArray(items) || items.length !== 1) throw new RelayRefusal("quote-steps", "the deposit step is not a single transaction");
  const data = (items[0] as {data?: unknown} | null)?.data;
  if (data === null || typeof data !== "object") throw new RelayRefusal("quote-steps", "the deposit step has no transaction");
  const requestId = typeof found.requestId === "string" ? found.requestId.toLowerCase() : "";
  if (!REQUEST_ID.test(requestId)) throw new RelayRefusal("quote-steps", "the quote has no request id to track the deposit by");
  return {requestId, tx: data as never};
}

export function relayProvider(config: RelayProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const base = (config.baseUrl ?? RELAY_API).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("relay: baseUrl must use http or https");
  const quoteTtlMs = config.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  if (!Number.isInteger(quoteTtlMs) || quoteTtlMs <= 0 || quoteTtlMs > 300_000) throw new Error("relay: quoteTtlMs must be an integer between 1 and 300000");
  if (config.apiKey !== undefined && (typeof config.apiKey !== "string" || !/^[\x21-\x7e]{1,256}$/.test(config.apiKey))) throw new Error("relay: apiKey must be a printable string");
  const doFetch: typeof fetch = (input, init) => (config.fetchImpl ?? fetch)(input, init);
  const headers = (json: boolean): Record<string, string> => ({
    accept: "application/json",
    ...(json ? {"content-type": "application/json"} : {}),
    ...(config.apiKey ? {"x-api-key": config.apiKey} : {}),
  });

  // The request each live quote answered, kept on this side: a deposit is checked against what was asked here, not
  // against what the quote object says was asked.
  const issued = new Map<string, RelayRequest>();
  const remember = <K, V>(m: Map<K, V>, k: K, v: V): void => {
    m.delete(k);
    m.set(k, v);
    if (m.size > MAX_REMEMBERED) m.delete(m.keys().next().value as K);
  };

  /** The request a quote is checked against before a build or a signature. */
  function requestOf(quote: Quote): RelayRequest {
    const pd = quote.providerData ?? {};
    const sealed: RelayRequest = {
      sourceChain: pd.sourceChain ?? "", destChain: pd.destChain ?? "", sourceToken: pd.sourceToken ?? "", destToken: pd.destToken ?? "",
      amount: /^[1-9]\d{0,77}$/.test(pd.amount ?? "") ? BigInt(pd.amount!) : 0n,
      depositor: pd.depositor ?? "", recipient: pd.recipient ?? "",
      ...(/^\d{1,78}$/.test(pd.minAmountOut ?? "") ? {minAmountOut: BigInt(pd.minAmountOut!)} : {}),
      ...(/^\d{1,5}$/.test(pd.slippageBps ?? "") ? {slippageBps: Number(pd.slippageBps)} : {}),
    };
    // The pricing placeholder is never a party to a deposit, whatever flags the quote object carries.
    if (sealed.depositor.toLowerCase() === EVM_PLACEHOLDER.toLowerCase() || sealed.recipient.toLowerCase() === EVM_PLACEHOLDER.toLowerCase()) {
      throw new RelayRefusal("request-invalid", "a quote priced without the real addresses is never built or signed — quote again with them");
    }
    const mine = issued.get(quote.intentId);
    if (!mine) return sealed;
    const same = mine.sourceChain === sealed.sourceChain && mine.destChain === sealed.destChain && mine.amount === sealed.amount
      && mine.sourceToken.toLowerCase() === sealed.sourceToken.toLowerCase() && mine.destToken.toLowerCase() === sealed.destToken.toLowerCase()
      && mine.depositor.toLowerCase() === sealed.depositor.toLowerCase() && mine.recipient.toLowerCase() === sealed.recipient.toLowerCase();
    if (!same) throw new RelayRefusal("request-invalid", "the quote no longer says what was asked when it was issued — quote again");
    return mine;
  }

  async function readJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error("relay: response too large");
    return JSON.parse(text) as unknown;
  }

  return {
    name: "relay",
    describeActivity: describeRelayActivity,
    enabled: () => config.enabled ?? true,
    supportsChain: (chain: string) => relayCfg.supportsChain(chain),
    supportsChainPair: (from: string, to: string) => relayCfg.supports(from, to),
    supportsRoute: (from: Asset, to: Asset) => relayCfg.supports(from.chain, to.chain),

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (reason: string) => { params.onRefusal?.(reason); return null; };
      const dry = params.dry !== false;
      // Only a quote priced with the placeholder is unbuildable; one asked with real addresses is a real order.
      const placeholder = dry && (!params.destAddress || !params.refundAddress);
      let request: RelayRequest;
      try {
        // The placeholder prices a dry quote; a live one without addresses is refused.
        request = relayRequestOf(params, dry ? {placeholder: EVM_PLACEHOLDER} : {});
      } catch (err) {
        if (err instanceof RelayRefusal) return refuse(err.message);
        throw err;
      }
      const src = relayChain(request.sourceChain)!;
      const dst = relayChain(request.destChain)!;
      let body: RelayQuoteBody;
      try {
        const res = await doFetch(`${base}/quote/v2`, {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({
            user: request.depositor,
            recipient: request.recipient,
            refundTo: request.depositor,
            originChainId: src.chainId,
            destinationChainId: dst.chainId,
            originCurrency: request.sourceToken.toLowerCase(),
            destinationCurrency: request.destToken.toLowerCase(),
            amount: request.amount.toString(10),
            tradeType: "EXACT_INPUT",
            includeProtocolData: true,
            // Always named: Relay's "auto" would leave the distance between expected and minimum to the answering side.
            slippageTolerance: String(request.slippageBps ?? RELAY_DEFAULT_SLIPPAGE_BPS),
          }),
          signal: signal ? anySignal([signal, timeoutSignal(QUOTE_TIMEOUT_MS)]) : timeoutSignal(QUOTE_TIMEOUT_MS),
        });
        let parsed: unknown;
        try { parsed = await readJson(res); } catch { parsed = null; }
        if (!res.ok) {
          const e = (parsed ?? {}) as RelayQuoteBody;
          const why = typeof e.message === "string" ? clip(e.message) : `HTTP ${res.status}`;
          return refuse(`relay: no quote — ${typeof e.errorCode === "string" ? `${clip(e.errorCode, 60)}: ` : ""}${why}`);
        }
        if (parsed === null || typeof parsed !== "object") return refuse("relay: the quote response is not JSON");
        body = parsed as RelayQuoteBody;
      } catch (err) {
        return refuse(`relay: quote request failed — ${clip(err instanceof Error ? err.message : String(err))}`);
      }

      try {
        const step = depositStep(body);
        const proto = (body.protocol?.v2 ?? null) as Record<string, unknown> | null;
        const v = verifyRelayOrder(request, proto, step.tx);
        // Extras this module never asks for. Each lowers the output inside a genuine order; the response's own account
        // of them is only a hint (an answering side that adds one can also hide it), so this refuses the honest case.
        const extra = (x: unknown): boolean => x !== undefined && x !== null && x !== "0" && x !== 0;
        if (extra(body.fees?.app?.amount)) throw new RelayRefusal("app-fee", "the quote charges an app fee this module did not ask for");
        if (extra(body.details?.currencyGasTopup?.amount)) throw new RelayRefusal("gas-topup", "the quote converts part of the output into a gas top-up this module did not ask for");
        const native = v.deposit.approvalAddress === undefined;
        const floor = native ? GAS_FLOOR_NATIVE : GAS_FLOOR_ERC20;
        const apiGas = typeof step.tx.gas === "string" && /^[1-9]\d{0,9}$/.test(step.tx.gas) ? BigInt(step.tx.gas) * 2n : 0n;
        const gasLimit = apiGas > GAS_CAP ? GAS_CAP : apiGas > floor ? apiGas : floor;

        // Fees are Relay's own account of the quote: shown, never used in a check. They are already inside the output.
        const relayer = body.fees?.relayer;
        const usd = typeof relayer?.amountUsd === "string" && /^\d{1,12}(?:\.\d{1,18})?$/.test(relayer.amountUsd) ? parseFloat(relayer.amountUsd) : 0;
        const feeToken = relayer?.currency?.address;
        const fees = typeof relayer?.amount === "string" && /^[1-9]\d{0,77}$/.test(relayer.amount) && typeof feeToken === "string" && /^0x[0-9a-fA-F]{40}$/.test(feeToken)
          ? [{type: "protocol" as const, amount: relayer.amount, token: feeToken.toLowerCase(), included: true, description: "Relay fee"}]
          : [];
        const eta = body.details?.timeEstimate;
        const etaSeconds = typeof eta === "number" && Number.isFinite(eta) && eta > 0 ? Math.min(Math.ceil(eta), 86_400) : 60;

        const intentId = `${INTENT_PREFIX}${step.requestId}`;
        if (!placeholder) remember(issued, intentId, request);
        return {
          provider: "relay",
          intentId,
          depositAddress: "",
          depositMemo: null,
          txRequest: {
            to: v.deposit.to,
            data: v.deposit.data,
            value: v.deposit.value,
            chainId: v.deposit.chainId,
            gasLimit: gasLimit.toString(10),
            ...(v.deposit.approvalAddress ? {approvalAddress: v.deposit.approvalAddress} : {}),
          },
          sourceAmount: request.amount.toString(10),
          destAmount: v.expectedAmount.toString(10),
          minDestAmount: v.minimumAmount.toString(10),
          feeUsd: usd,
          fees,
          etaSeconds,
          reliability: 0.97,
          validUntilMs: Date.now() + quoteTtlMs,
          providerData: {
            requestId: step.requestId,
            orderId: v.id,
            hubType: "onchain",
            // The order as received, re-read by the same parser before a build and before a signature.
            orderData: JSON.stringify(proto!.orderData),
            orderSignature: String(proto!.orderSignature).toLowerCase(),
            paymentDetails: JSON.stringify(proto!.paymentDetails),
            sourceChain: request.sourceChain,
            destChain: request.destChain,
            sourceToken: request.sourceToken.toLowerCase(),
            destToken: request.destToken.toLowerCase(),
            amount: request.amount.toString(10),
            depositor: request.depositor.toLowerCase(),
            recipient: request.recipient.toLowerCase(),
            ...(request.minAmountOut !== undefined ? {minAmountOut: request.minAmountOut.toString(10)} : {}),
            ...(request.slippageBps !== undefined ? {slippageBps: String(request.slippageBps)} : {}),
            ...(placeholder ? {placeholder: "1"} : {}),
          },
        };
      } catch (err) {
        if (err instanceof RelayRefusal) return refuse(err.message);
        return refuse(`relay: unreadable quote — ${clip(err instanceof Error ? err.message : String(err))}`);
      }
    },

    /** The quote's own transaction — after the order it carries has been verified once more. */
    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx || !quote.intentId.startsWith(INTENT_PREFIX)) throw new Error("swap2: Relay quote has no transaction request");
      if (quote.providerData?.placeholder === "1") throw new RelayRefusal("request-invalid", "a quote priced without the real addresses is never built — quote again with them");
      const request = requestOf(quote);
      const v = checkRelayQuote(request, quote);
      return {
        chain: request.sourceChain,
        to: v.deposit.to,
        value: v.deposit.value,
        data: v.deposit.data,
        chainId: v.deposit.chainId,
        ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}),
        ...(v.deposit.approvalAddress ? {approvalAddress: v.deposit.approvalAddress} : {}),
      };
    },

    /**
     * Right before signing: the whole verification again, against the request this instance issued the quote for
     * and the exact transaction about to be signed — and each order is cleared for one deposit only.
     */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      if (quote.providerData?.placeholder === "1") throw new RelayRefusal("request-invalid", "a quote priced without the real addresses is never signed");
      const request = requestOf(quote);
      if (tx.chain !== request.sourceChain) throw new RelayRefusal("tx-chain", `the deposit is for ${tx.chain}, not ${request.sourceChain}`);
      if (tx.serializedTx !== undefined || tx.memo !== undefined || tx.typedData !== undefined || tx.bodyBoc !== undefined) {
        throw new RelayRefusal("quote-shape", "a Relay deposit is one EVM call");
      }
      const v = checkRelayQuote(request, quote, tx);
      const store = config.clearedStore;
      if (store && await store.has(v.id)) throw new RelayRefusal("order-reused", `order ${v.id} was already cleared for a deposit — quote again`);
      relayClearOrder(v.id, "sign");
      // Kept until the order's own deadline: a deposit for it is never signed twice, restart or not.
      if (store) await store.add(v.id, v.order.output.deadline * 1000);
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (typeof ref.intentId !== "string" || !ref.intentId.startsWith(INTENT_PREFIX)) return {state: "failed"};
      const requestId = ref.intentId.slice(INTENT_PREFIX.length);
      if (!REQUEST_ID.test(requestId)) return {state: "failed"};
      // Nothing was sent yet: Relay answers "waiting" for a request it has seen no deposit for.
      if (!ref.sourceTxHash) return {state: "pending"};
      try {
        const res = await doFetch(`${base}/intents/status/v3?requestId=${requestId}`, {headers: headers(false), signal: timeoutSignal(STATUS_TIMEOUT_MS)});
        if (!res.ok) return {state: "pending"};
        const s = (await readJson(res)) as {status?: unknown; txHashes?: unknown; refundFailReason?: unknown} | null;
        const status = typeof s?.status === "string" ? s.status.toLowerCase() : "";
        const state = Object.prototype.hasOwnProperty.call(RELAY_STATUS_MAP, status) ? RELAY_STATUS_MAP[status]! : "pending";
        const seen = status !== "waiting" && status !== "unknown" && status !== "";
        if (state === "completed") {
          const hashes = Array.isArray(s?.txHashes) ? s.txHashes.filter((h): h is string => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h)) : [];
          const dest = hashes[hashes.length - 1] ?? ref.destTxHash ?? undefined;
          return {state, depositReceived: true, ...(dest ? {destTxHash: dest} : {})};
        }
        if (status === "failure") {
          // A failed fill is refunded by Relay on its own. Only when the refund itself failed is there nothing
          // more coming without Relay's support.
          const why = typeof s?.refundFailReason === "string" ? s.refundFailReason.trim() : "";
          return {state: why !== "" && why.toUpperCase() !== "N/A" ? "failed" : "refund-pending", depositReceived: true};
        }
        return {state, ...(seen ? {depositReceived: true} : {})};
      } catch {
        return {state: "pending"};
      }
    },
  };
}
