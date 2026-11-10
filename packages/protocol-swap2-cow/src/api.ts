/**
 * The CoW Protocol orderbook (docs.cow.fi → Order Book API): the public API, no key. Everything it answers is data
 * to check, never an instruction — the provider validates each field it uses; this file only moves JSON and turns
 * the API's error types into refusals a person can read.
 */
import {anySignal, redactUrls, timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import {COW_API_BASE} from "./deployments.js";

/** The largest response body read (a page of an account's orders with their appData documents is the biggest one). */
const MAX_BODY_CHARS = 4_000_000;

/** What the orderbook's error types mean for the person swapping. Types not listed are shown as they are. */
const FRIENDLY: Readonly<Record<string, string>> = {
  NoLiquidity: "no route for this pair",
  InsufficientLiquidity: "not enough liquidity for this amount",
  SellAmountDoesNotCoverFee: "the amount is too small to cover the network cost of the swap",
  UnsupportedToken: "CoW Protocol does not trade this token",
  TokenTemporarilySuspended: "trading of this token is suspended on CoW Protocol",
  SameBuyAndSellToken: "same token in and out",
  InvalidNativeSellToken: "the native coin is sold through eth-flow only",
  QuoteNotVerified: "the quote could not be verified by simulation",
  TradingOutsideAllowedWindow: "this token trades only inside its allowed window",
  InsufficientBalance: "the wallet's balance is below the amount",
  InsufficientAllowance: "the allowance for the CoW vault relayer does not cover the order",
  InsufficientValidTo: "the order would expire too soon",
  ExcessiveValidTo: "the order's expiry is too far in the future",
  TransferSimulationFailed: "the sell token cannot be transferred from this wallet",
  TooManyLimitOrders: "this wallet has too many open orders",
  Forbidden: "the orderbook refuses orders from this wallet",
  OnChainOrder: "this order was placed on-chain and can only be cancelled on-chain",
  AlreadyCancelled: "the order is cancelled already",
  OrderFullyExecuted: "the order has been filled already",
  OrderExpired: "the order has expired already",
};

/** An answer of the orderbook that is not a success. `errorType` is the API's own (letters, digits, underscore) or `HTTP <status>`. */
export class CowApiError extends Error {
  readonly status: number;
  readonly errorType: string;
  constructor(status: number, errorType: string, description: string) {
    const what = FRIENDLY[errorType] ?? (status === 429 ? "rate limited (HTTP 429)" : errorType);
    super(`cow: ${what}${description && !FRIENDLY[errorType] ? ` (${description})` : ""}`);
    this.name = "CowApiError";
    this.status = status;
    this.errorType = errorType;
  }
}

/** Text from the API as it may appear in a message: one line, no URLs, at most 160 characters. */
function tidy(text: unknown): string {
  if (typeof text !== "string") return "";
  let out = "";
  for (const ch of text.slice(0, 400)) {
    const c = ch.charCodeAt(0);
    out += c < 32 || c === 127 ? " " : ch;
  }
  out = redactUrls(out).trim();
  return out.length > 160 ? `${out.slice(0, 160)}…` : out;
}

export interface CowApiConfig {
  /** Orderbook base URL (https). Default `https://api.cow.fi`. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface CowApi {
  quote(network: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
  /** Places a signed order; the answer is its UID. */
  postOrder(network: string, body: unknown): Promise<unknown>;
  cancelOrders(network: string, body: {orderUids: string[]; signature: string; signingScheme: "eip712"}): Promise<void>;
  /** The order, or null when the orderbook does not know the UID. */
  order(network: string, uid: string): Promise<Record<string, unknown> | null>;
  trades(network: string, uid: string): Promise<unknown[]>;
  /** The account's orders, newest first (one page). */
  accountOrders(network: string, owner: string, limit: number): Promise<unknown[]>;
  /** Registers the appData document under its hash (the orderbook checks the hash). */
  putAppData(network: string, hash: string, json: string): Promise<void>;
}

export function cowApi(config: CowApiConfig = {}): CowApi {
  const base = (config.baseUrl ?? COW_API_BASE).replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/.test(base)) throw new Error("cow: the orderbook URL must be a plain https URL");
  const timeoutMs = config.timeoutMs ?? 12_000;

  async function send(method: string, network: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{status: number; json: unknown}> {
    if (!/^[a-z0-9_]{1,40}$/.test(network)) throw new Error("cow: malformed orderbook network");
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${base}/${network}${path}`, {
        method,
        headers: {accept: "application/json", ...(body === undefined ? {} : {"content-type": "application/json"})},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        signal: signal ? anySignal([signal, timeoutSignal(timeoutMs)]) : timeoutSignal(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      throw new Error(`cow: the orderbook is unreachable (${e instanceof Error ? e.name : "error"})`);
    }
    if (text.length > MAX_BODY_CHARS) throw new Error("cow: the orderbook's answer is too large");
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = json && typeof json === "object" ? (json as {errorType?: unknown; description?: unknown}) : {};
      const type = typeof err.errorType === "string" && /^[A-Za-z0-9_]{1,60}$/.test(err.errorType) ? err.errorType : `HTTP ${res.status}`;
      throw new CowApiError(res.status, type, tidy(err.description));
    }
    if (json === undefined) throw new Error("cow: malformed orderbook answer");
    return {status: res.status, json};
  }

  const uidPath = (uid: string): string => {
    if (!/^0x[0-9a-fA-F]{112}$/.test(uid)) throw new Error("cow: order UID must be 56 bytes");
    return uid.toLowerCase();
  };
  const list = (json: unknown): unknown[] => {
    if (!Array.isArray(json)) throw new Error("cow: malformed orderbook answer (not a list)");
    return json;
  };

  return {
    async quote(network, body, signal) {
      return (await send("POST", network, "/api/v1/quote", body, signal)).json;
    },
    async postOrder(network, body) {
      return (await send("POST", network, "/api/v1/orders", body)).json;
    },
    async cancelOrders(network, body) {
      await send("DELETE", network, "/api/v1/orders", body);
    },
    async order(network, uid) {
      try {
        const {json} = await send("GET", network, `/api/v1/orders/${uidPath(uid)}`);
        if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("cow: malformed orderbook answer (order)");
        return json as Record<string, unknown>;
      } catch (e) {
        if (e instanceof CowApiError && e.status === 404) return null;
        throw e;
      }
    },
    async trades(network, uid) {
      return list((await send("GET", network, `/api/v2/trades?orderUid=${uidPath(uid)}`)).json);
    },
    async accountOrders(network, owner, limit) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error("cow: owner must be an address");
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("cow: page size must be 1..1000");
      return list((await send("GET", network, `/api/v1/account/${owner.toLowerCase()}/orders?offset=0&limit=${limit}`)).json);
    },
    async putAppData(network, hash, json) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("cow: appData hash must be 32 bytes");
      await send("PUT", network, `/api/v1/app_data/${hash.toLowerCase()}`, {fullAppData: json});
    },
  };
}
