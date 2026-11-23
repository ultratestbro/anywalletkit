// A stub of the two things the module talks to — the CoW orderbook and a JSON-RPC node — behind one `fetch`.
// The orderbook answers quotes from a fixed price and echoes the request the way the real one does; tests bend
// single fields of the answer (`tamper`) to prove each is checked. Nothing here reaches the network.
import {decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, stringToHex, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {COW_DEPLOYMENTS} from "../src/deployments.js";
import {ETH_FLOW_ABI} from "../src/ethflow.js";
import {EIP2612_PERMIT_TYPEHASH, permitDomainSeparator} from "../src/permit.js";
import {vi} from "vitest";
import type {CrossChainProvider, Quote} from "@anywalletkit/protocol-swap2-core/types";
import {orderTypedData, orderUid, rawOrderDigest, type CowOrder, type CowRawOrder} from "../src/order.js";
import {cowProvider, type CowProviderConfig} from "../src/provider.js";

/** A throwaway key derived from a label — it holds nothing and exists only so signatures in tests are real. */
export const signer = privateKeyToAccount(keccak256(stringToHex("protocol-swap2-cow test account")));
export const other = privateKeyToAccount(keccak256(stringToHex("protocol-swap2-cow another account")));
export const ME = signer.address;
export const OTHER = other.address;

export const D1 = COW_DEPLOYMENTS[1]!;
export const D8453 = COW_DEPLOYMENTS[8453]!;
export const D42161 = COW_DEPLOYMENTS[42161]!;
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const WETH = D1.wrappedNative;
export const ZERO = "0x0000000000000000000000000000000000000000";
export const RPC_URL = "https://rpc.test";
export const RPC = {1: [RPC_URL], 8453: [RPC_URL], 42161: [RPC_URL]};

const TOKEN_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function PERMIT_TYPEHASH() view returns (bytes32)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])",
]);
const SETTLEMENT_ABI = parseAbi(["function filledAmount(bytes orderUid) view returns (uint256)"]);

export interface World {
  /** Unix ms; the orderbook stamps `validTo` and `expiration` from it. */
  clock: () => number;
  /** Output per unit of input after the fee, as a fraction. */
  rate: [bigint, bigint];
  fee: bigint;
  quoteId: number | null;
  /** "refuse" answers QuoteNotVerified to a `verified` request and prices the `optimal` one. */
  verified: boolean | "refuse";
  /** An error the next quote answers with. */
  quoteError?: {status: number; errorType: string; description?: string};
  /** Bends the quote answer before it is sent. */
  tamper?: (answer: {quote: Record<string, unknown>; [k: string]: unknown}) => unknown;
  /** Orders the orderbook lists, by lowercase UID. */
  orders: Map<string, Record<string, unknown>>;
  /** `GET /account/<owner>/orders`; "down" answers 500. */
  accountOrders: unknown[] | "down";
  trades: Map<string, unknown[]>;
  /** Errors the next `POST /orders` calls answer with, in order. */
  postErrors: {status: number; errorType: string}[];
  /** The UID `POST /orders` answers; default: the one computed from the body by the test (`postAnswer`). */
  postAnswer?: (body: Record<string, unknown>) => unknown;
  cancelError?: {status: number; errorType: string};
  apiDown: boolean;
  // What the stub saw.
  quotes: Record<string, unknown>[];
  posted: Record<string, unknown>[];
  cancelled: Record<string, unknown>[];
  appData: {hash: string; body: Record<string, unknown>}[];
  // The chain.
  rpcDown: boolean;
  allowance: bigint;
  /** The sell token's EIP-2612 face; null = the token has no permit. */
  permitToken: {name: string; version?: string; nonce: bigint; typeHash?: string; separator?: Hex} | null;
  /** Gas `eth_estimateGas` answers for the permit call; "revert" refuses it. */
  permitGas: bigint | "revert";
  /** What Arbitrum's NodeInterface answers for the L1 part of a gas estimate; "down" = no answer. */
  arbitrumL1Gas: bigint | "down";
  ethFlowOrders: Map<string, {owner: string; validTo: number}>;
  filled: Map<string, bigint>;
  code: Map<string, string>;
  receipts: Map<string, {status: string}>;
  rpcCalls: {method: string; params: unknown[]}[];
}

export function world(over: Partial<World> = {}): World {
  return {
    clock: Date.now,
    rate: [1n, 2500n], // 2500 USDC (6) per WETH-ish unit, scaled by the tests' amounts
    fee: 1000n,
    quoteId: 777,
    verified: true,
    orders: new Map(),
    accountOrders: [],
    trades: new Map(),
    postErrors: [],
    apiDown: false,
    quotes: [],
    posted: [],
    cancelled: [],
    appData: [],
    rpcDown: false,
    allowance: 0n,
    permitToken: {name: "USD Coin", version: "2", nonce: 0n},
    permitGas: 60_000n,
    arbitrumL1Gas: 0n,
    ethFlowOrders: new Map(),
    filled: new Map(),
    code: new Map(),
    receipts: new Map(),
    rpcCalls: [],
    ...over,
  };
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}});
const apiError = (e: {status: number; errorType: string; description?: string}): Response => json(e.status, {errorType: e.errorType, description: e.description ?? "stub"});
const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;

/** The quote the orderbook would answer for `body` in this world. */
export function quoteAnswer(w: World, body: Record<string, unknown>): {quote: Record<string, unknown>; [k: string]: unknown} {
  const amountIn = BigInt(body.sellAmountBeforeFee as string);
  const sellAmount = amountIn - w.fee;
  return {
    quote: {
      sellToken: body.sellToken,
      buyToken: body.buyToken,
      receiver: body.receiver,
      sellAmount: sellAmount.toString(),
      buyAmount: ((sellAmount * w.rate[0]) / w.rate[1]).toString(),
      validTo: Math.floor(w.clock() / 1000) + (body.validFor as number),
      appData: body.appData,
      appDataHash: body.appDataHash,
      feeAmount: w.fee.toString(),
      kind: "sell",
      partiallyFillable: false,
      sellTokenBalance: "erc20",
      buyTokenBalance: "erc20",
      signingScheme: body.signingScheme,
    },
    from: body.from,
    expiration: new Date(w.clock() + 120_000).toISOString(),
    id: w.quoteId,
    verified: w.verified === true,
  };
}

function rpcResult(w: World, method: string, params: unknown[]): unknown {
  const revert = () => {
    throw Object.assign(new Error("execution reverted"), {rpc: true});
  };
  if (method === "eth_getCode") return w.code.get(String(params[0]).toLowerCase()) ?? "0x";
  if (method === "eth_getTransactionReceipt") return w.receipts.get(String(params[0]).toLowerCase()) ?? null;
  if (method === "eth_estimateGas") return w.permitGas === "revert" ? revert() : `0x${w.permitGas.toString(16)}`;
  if (method !== "eth_call") return revert();
  const {to, data} = params[0] as {to: string; data: Hex};
  const target = to.toLowerCase();
  if (target === "0x00000000000000000000000000000000000000c8") {
    if (w.arbitrumL1Gas === "down") return revert();
    return encodeAbiParameters([{type: "uint64"}, {type: "uint256"}, {type: "uint256"}], [w.arbitrumL1Gas, 20_000_000n, 300_000_000n]);
  }
  if (target === D1.ethFlow.toLowerCase()) {
    const call = decodeFunctionData({abi: ETH_FLOW_ABI, data});
    if (call.functionName !== "orders") return revert();
    const o = w.ethFlowOrders.get((call.args[0] as string).toLowerCase()) ?? {owner: ZERO, validTo: 0};
    return encodeAbiParameters([{type: "address"}, {type: "uint32"}], [o.owner as Hex, o.validTo]);
  }
  if (target === D1.settlement.toLowerCase()) {
    const call = decodeFunctionData({abi: SETTLEMENT_ABI, data});
    return word(w.filled.get((call.args[0] as string).toLowerCase()) ?? 0n);
  }
  // Anything else is the sell token.
  const call = decodeFunctionData({abi: TOKEN_ABI, data});
  if (call.functionName === "allowance") return word(w.allowance);
  const p = w.permitToken;
  if (!p) return revert();
  const chainId = 1;
  switch (call.functionName) {
    case "nonces": return word(p.nonce);
    case "DOMAIN_SEPARATOR": return p.separator ?? permitDomainSeparator(chainId, to, p.version === undefined ? {name: p.name} : {name: p.name, version: p.version});
    case "PERMIT_TYPEHASH": return p.typeHash ?? EIP2612_PERMIT_TYPEHASH;
    case "name": return encodeAbiParameters([{type: "string"}], [p.name]);
    case "version": return p.version === undefined ? revert() : encodeAbiParameters([{type: "string"}], [p.version]);
    default: return revert();
  }
}

/** `fetch` for a world: `api.cow.fi/<network>/…` is the orderbook, `rpc.test` the node; anything else fails the test. */
export function stub(w: World): typeof fetch {
  return (async (input: string | URL, init?: {method?: string; body?: string}) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.origin === RPC_URL) {
      if (w.rpcDown) return new Response("down", {status: 503});
      const {method, params} = body as {method: string; params: unknown[]};
      w.rpcCalls.push({method, params});
      try {
        return json(200, {jsonrpc: "2.0", id: 1, result: rpcResult(w, method, params)});
      } catch (e) {
        return json(200, {jsonrpc: "2.0", id: 1, error: {code: 3, message: (e as Error).message}});
      }
    }
    if (url.origin !== "https://api.cow.fi") throw new Error(`unexpected request to ${url.origin}`);
    if (w.apiDown) return new Response("down", {status: 503});
    const path = url.pathname.replace(/^\/[a-z0-9_]+/, "");
    const method = init?.method ?? "GET";
    if (method === "POST" && path === "/api/v1/quote") {
      w.quotes.push(body);
      if (w.quoteError) return apiError(w.quoteError);
      if (w.verified === "refuse" && body.priceQuality === "verified") return apiError({status: 400, errorType: "QuoteNotVerified"});
      const answer = quoteAnswer(w, body);
      return json(200, w.tamper ? w.tamper(answer) : answer);
    }
    if (method === "POST" && path === "/api/v1/orders") {
      w.posted.push(body);
      const err = w.postErrors.shift();
      if (err) return apiError(err);
      return json(201, w.postAnswer ? w.postAnswer(body) : "0x");
    }
    if (method === "DELETE" && path === "/api/v1/orders") {
      w.cancelled.push(body);
      return w.cancelError ? apiError(w.cancelError) : json(200, "Cancelled");
    }
    if (method === "PUT" && path.startsWith("/api/v1/app_data/")) {
      w.appData.push({hash: path.slice("/api/v1/app_data/".length), body});
      return json(201, path.slice("/api/v1/app_data/".length));
    }
    if (method === "GET" && path.startsWith("/api/v1/orders/")) {
      const order = w.orders.get(path.slice("/api/v1/orders/".length).toLowerCase());
      return order ? json(200, order) : apiError({status: 404, errorType: "NotFound"});
    }
    if (method === "GET" && path === "/api/v2/trades") return json(200, w.trades.get((url.searchParams.get("orderUid") ?? "").toLowerCase()) ?? []);
    if (method === "GET" && /^\/api\/v1\/account\/0x[0-9a-f]{40}\/orders$/.test(path)) {
      return w.accountOrders === "down" ? apiError({status: 500, errorType: "InternalServerError"}) : json(200, w.accountOrders);
    }
    throw new Error(`unexpected orderbook request ${method} ${path}`);
  }) as unknown as typeof fetch;
}

/** Quote parameters for USDC → WETH on Ethereum from {@link ME}. */
export const usdcToWeth = (over: Record<string, unknown> = {}) => ({
  sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "USDC", destToken: WETH, amountIn: "25000000", destAddress: ME, refundAddress: ME, ...over,
});
/** Quote parameters for ETH → USDC on Ethereum from {@link ME} (eth-flow). */
export const ethToUsdc = (over: Record<string, unknown> = {}) => ({
  sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "ETH", destToken: USDC, amountIn: "10000000000000000", destAddress: ME, refundAddress: ME, ...over,
});

// ── a provider over a world ─────────────────────────────────────────────────────────────────────

/** The tests' present, unix seconds; `Time` moves it. */
export const NOW = 1_800_000_000;
export interface Time {
  ms: number;
  /** Moves the clock forward by `seconds`. */
  pass(seconds: number): void;
}
export const time = (): Time => {
  const t: Time = {ms: NOW * 1000, pass: (seconds) => void (t.ms += seconds * 1000)};
  return t;
};

/** The UID the real orderbook would answer for a posted order: the digest of its fields, its owner, its expiry. */
export const uidOfPosted = (chainId: number, body: Record<string, unknown>): string =>
  orderUid(rawOrderDigest(chainId, {...(body as unknown as CowRawOrder), appData: body.appDataHash as string}), body.from as string, body.validTo as number);

/** A provider over a fresh world with one clock for both; the stubbed orderbook answers the honest UID to a posted order. */
export function setup(over: Partial<World> = {}, config: CowProviderConfig = {}): {w: World; p: CrossChainProvider; t: Time; refusals: string[]; quote: (params: Record<string, unknown>) => Promise<Quote | null>} {
  const t = time();
  const w = world({clock: () => t.ms, postAnswer: (body) => uidOfPosted(1, body), ...over});
  vi.stubGlobal("fetch", stub(w));
  const p = cowProvider({enabled: true, rpcUrls: RPC, now: () => t.ms, ...config});
  const refusals: string[] = [];
  const quote = (params: Record<string, unknown>) => p.getQuote({...params, onRefusal: (r: string) => refusals.push(r)} as never);
  return {w, p, t, refusals, quote};
}

/** Signs typed data as a wallet does (`eth_signTypedData_v4`): the JSON a build carries, by `by`. */
export function signTyped(typedData: string, by: {signTypedData: (td: never) => Promise<string>} = signer as never): Promise<string> {
  const td = JSON.parse(typedData) as {domain: unknown; types: Record<string, unknown>; primaryType: string; message: unknown};
  const {EIP712Domain: _domain, ...types} = td.types;
  return by.signTypedData({domain: td.domain, types, primaryType: td.primaryType, message: td.message} as never);
}

/** An open order of {@link ME} as `GET /account/<owner>/orders` lists it — really signed; `forge` bends the listing afterwards. */
export async function listedOrder(over: Partial<CowRawOrder> = {}, forge: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const order: CowRawOrder = {
    sellToken: USDC.toLowerCase(), buyToken: WETH.toLowerCase(), receiver: ME.toLowerCase(), sellAmount: "5000000", buyAmount: "1", validTo: NOW + 600,
    appData: `0x${"22".repeat(32)}`, feeAmount: "0", kind: "sell", partiallyFillable: false, sellTokenBalance: "erc20", buyTokenBalance: "erc20", ...over,
  };
  const uid = orderUid(rawOrderDigest(1, order), ME, order.validTo);
  const signature = await signTyped(JSON.stringify({...orderTypedData(1, order as CowOrder)}));
  return {...order, uid, owner: ME.toLowerCase(), signature, signingScheme: "eip712", status: "open", invalidated: false, executedSellAmount: "0", ...forge};
}
