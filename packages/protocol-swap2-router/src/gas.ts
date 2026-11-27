/**
 * The source gas a route costs the user, in USD (SDK-291): what the router subtracts from every quote's net value
 * so a venue whose swap a third party pays for (a CoW solver, an Omniston gasless order) and a venue whose swap the
 * user sends are compared on what the user actually gets.
 *
 * Gas units come from the quote, not from a dry run: a dry quote has no sender with balance or allowance to run it
 * from. A quote that says what its source transaction is expected to use (`gasEstimate`, see protocol-swap2-core)
 * counts that — the gas used, not the limit with the venue's headroom (Fynd's limit is its estimate × 1.3 + 80 000),
 * so routes compare on what they cost; at least {@link SOURCE_GAS_UNITS}.estimateFloor, at most `callCap`. Without
 * one, a calldata route counts the venue's `txRequest.gasLimit` (capped), else {@link SOURCE_GAS_UNITS}.call; a
 * deposit-address route counts a plain transfer; a `gasless` quote counts no swap gas. An ERC-20 route that names a
 * spender (`txRequest.approvalAddress`, or a gasless order's `providerData.approvalAddress`) adds an approval, unless the sender is known and its allowance already covers the amount. The gas price is
 * the chain's `eth_gasPrice` (cached per chain). EVM sources only: on another source chain every route pays the same
 * kind of network fee, and the function answers 0.
 */
import {bigintToUnits} from "@anywalletkit/core";
import {ccAssetByToken, ccChain} from "@anywalletkit/swap2-assets";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {anySignal, timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import {priceOf} from "./value.js";

/** Gas units the estimate falls back to, per kind of source transaction. */
export const SOURCE_GAS_UNITS = Object.freeze({
  /** A plain native transfer to a deposit address. */
  nativeTransfer: 21_000n,
  /** An ERC-20 `transfer` to a deposit address. */
  tokenTransfer: 65_000n,
  /** A venue's contract call when the quote names no gas limit. */
  call: 250_000n,
  /** An ERC-20 `approve` of the route's spender. */
  approve: 50_000n,
  /** The most a quoted gas limit (or gas estimate) counts for: a venue cannot price a rival out by naming a huge limit for itself. */
  callCap: 3_000_000n,
  /** The least a quote's `gasEstimate` counts for: no EVM transaction uses less than its intrinsic 21 000. */
  estimateFloor: 21_000n,
});

/** Where the estimate reads the chain: an RPC URL per CAIP-2 chain, or a JSON-RPC function. */
export interface SourceGasOptions {
  /** symbol → USD, the same map `usdValue` takes (prices the source chain's native coin). */
  prices: Readonly<Record<string, number>>;
  /** The JSON-RPC endpoint of an EVM chain (`eip155:<id>`), or undefined when there is none: gas is then unpriced. */
  rpcUrl?: (chain: string) => string | undefined;
  /** Or a JSON-RPC call of your own (a viem client's `request`, a proxy): takes precedence over `rpcUrl`. */
  rpc?: (chain: string, method: string, params: unknown[]) => Promise<unknown>;
  /** How long a chain's gas price is reused (default 15 s). */
  gasPriceTtlMs?: number;
  /** Per RPC call (default 2 s). */
  timeoutMs?: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NATIVE = /^(|0x0{40}|0xe{40}|native)$/i;

/**
 * The source token's ERC-20 contract, "" for the native coin, undefined when unknown. `params.sourceToken` is a
 * catalog SYMBOL (or an unlisted token's contract), as the engine sends it; a contract or a native placeholder is
 * taken as given.
 */
export function sourceContract(params: Pick<QuoteParams, "sourceChain" | "sourceToken">): string | undefined {
  const token = params.sourceToken;
  if (NATIVE.test(token)) return "";
  if (ADDRESS.test(token)) return token;
  const asset = ccChain(params.sourceChain)?.assets.find((a) => a.symbol === token) ?? ccChain(params.sourceChain)?.assets.find((a) => a.symbol.toLowerCase() === token.toLowerCase());
  if (!asset) return undefined;
  return asset.contract && ADDRESS.test(asset.contract) ? asset.contract : asset.contract ? undefined : "";
}

/** Canonical gas units, as `Quote.gasEstimate` carries them. */
const GAS_UNITS = /^(?:0|[1-9][0-9]{0,9})$/;

/**
 * The gas units of a quote's source leg, without the approval (see {@link SOURCE_GAS_UNITS}): its `gasEstimate` when it
 * has a usable one (between `estimateFloor` and `callCap`), else the figure from its gas limit or its kind of route.
 */
export function swapGasUnits(quote: Pick<Quote, "txRequest" | "gasless" | "gasEstimate">, params: Pick<QuoteParams, "sourceChain" | "sourceToken">): bigint {
  if (quote.gasless === true) return 0n;
  // The expected gas used, when the quote states it: a zero on a quote that is not gasless says nothing and is passed over.
  const estimate = typeof quote.gasEstimate === "string" && GAS_UNITS.test(quote.gasEstimate) ? BigInt(quote.gasEstimate) : 0n;
  if (estimate > 0n) {
    return estimate < SOURCE_GAS_UNITS.estimateFloor ? SOURCE_GAS_UNITS.estimateFloor : estimate < SOURCE_GAS_UNITS.callCap ? estimate : SOURCE_GAS_UNITS.callCap;
  }
  const tx = quote.txRequest;
  if (tx?.data && tx.data !== "0x") {
    const quoted = tx.gasLimit !== undefined && /^\d{1,12}$/.test(tx.gasLimit) ? BigInt(tx.gasLimit) : 0n;
    return quoted > 0n ? (quoted < SOURCE_GAS_UNITS.callCap ? quoted : SOURCE_GAS_UNITS.callCap) : SOURCE_GAS_UNITS.call;
  }
  return sourceContract(params) === "" ? SOURCE_GAS_UNITS.nativeTransfer : SOURCE_GAS_UNITS.tokenTransfer;
}

/**
 * The ERC-20 spender a quote needs an approval for, when it names one: its transaction's `approvalAddress`, or for a
 * quote without one (a gasless order) `providerData.approvalAddress`.
 */
function spenderOf(quote: Pick<Quote, "txRequest" | "providerData">, token: string | undefined): string | undefined {
  if (!token) return undefined;
  const spender = quote.txRequest ? quote.txRequest.approvalAddress : quote.providerData?.approvalAddress;
  return spender && ADDRESS.test(spender) ? spender : undefined;
}

function hexBig(v: unknown): bigint | null {
  return typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null;
}

/**
 * `sourceGasUsd` for the router: `new CrossChainRouter(providers, {valueUsd: usdValue(prices), sourceGasUsd:
 * evmSourceGas({prices, rpcUrl})})`. Answers null when the gas cannot be priced (no RPC, no native price, the RPC
 * did not answer); the router then subtracts gas from no quote of that auction.
 */
export function evmSourceGas(options: SourceGasOptions): (quote: Quote, params: QuoteParams, signal?: AbortSignal) => Promise<number | null> {
  const ttl = options.gasPriceTtlMs ?? 15_000;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const prices = options.prices;
  const gasPrices = new Map<string, {at: number; price: Promise<bigint | null>}>();
  let id = 0;

  const call = async (chain: string, method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> => {
    if (options.rpc) return options.rpc(chain, method, params);
    const url = options.rpcUrl?.(chain);
    if (!url) throw new Error(`no RPC for ${chain}`);
    // Hermes has neither AbortSignal.timeout nor AbortSignal.any: core's helpers fall back to a timer.
    const timeout = timeoutSignal(timeoutMs);
    const res = await fetch(url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: ++id, method, params}),
      signal: signal ? anySignal([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const body = (await res.json()) as {result?: unknown; error?: unknown};
    if (body.error !== undefined) throw new Error("RPC error");
    return body.result;
  };

  const gasPrice = (chain: string): Promise<bigint | null> => {
    const hit = gasPrices.get(chain);
    if (hit && Date.now() - hit.at < ttl) return hit.price;
    const price = call(chain, "eth_gasPrice", []).then(hexBig, () => null);
    gasPrices.set(chain, {at: Date.now(), price});
    // A failed read is not cached: the next auction asks again.
    void price.then((p) => { if (p === null && gasPrices.get(chain)?.price === price) gasPrices.delete(chain); });
    return price;
  };

  return async (quote, params, signal) => {
    if (!params.sourceChain.startsWith("eip155:")) return 0;
    const native = ccAssetByToken(params.sourceChain, "");
    const nativePrice = native ? priceOf(prices, native.symbol) : null;
    if (!native || nativePrice === null) return null;
    let units = swapGasUnits(quote, params);
    const token = sourceContract(params);
    const spender = spenderOf(quote, token);
    if (spender) {
      let covered = false;
      if (params.sender && ADDRESS.test(params.sender)) {
        // allowance(owner, spender): a route whose approval is already in place costs no approval.
        const data = `0xdd62ed3e${params.sender.slice(2).toLowerCase().padStart(64, "0")}${spender.slice(2).toLowerCase().padStart(64, "0")}`;
        try {
          const allowance = hexBig(await call(params.sourceChain, "eth_call", [{to: token, data}, "latest"], signal));
          covered = allowance !== null && allowance >= BigInt(params.amountIn);
        } catch { /* unknown allowance: count the approval */ }
      }
      if (!covered) units += SOURCE_GAS_UNITS.approve;
    }
    if (units === 0n) return 0;
    const price = await gasPrice(params.sourceChain);
    if (price === null) return null;
    return bigintToUnits(units * price, native.decimals) * nativePrice;
  };
}
