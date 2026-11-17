import {apiTransport, amountField, assertApi, LayerZeroApiError, record, textField, type LayerZeroApiConfig} from "./transport.js";

export interface LayerZeroQuoteRequest {
  srcChainKey: string; dstChainKey: string;
  srcTokenAddress: string; dstTokenAddress: string;
  srcWalletAddress: string; dstWalletAddress: string;
  amount: bigint;
  dstNativeDropAmount?: bigint;
  feeTolerancePercent?: number;
}
/** Raw API evidence only. No route or userStep is executable without a separate reviewed adapter. */
export interface UnverifiedLayerZeroQuotes {quotes: readonly unknown[]; rejectedQuotes: readonly unknown[]; tokens: readonly unknown[]}
export function createLayerZeroServerApi(config: LayerZeroApiConfig & {apiKey: string}) {
  const globals = globalThis as typeof globalThis & {process?: {versions?: {node?: string}}};
  if (typeof window !== "undefined" || typeof globals.process?.versions?.node !== "string") throw new LayerZeroApiError("server-only");
  if (typeof config.apiKey !== "string" || !config.apiKey || config.apiKey.length > 4096 || /[\s\u0000-\u001f]/.test(config.apiKey)) throw new LayerZeroApiError("config");
  const request = apiTransport(config, config.apiKey);
  return {
    async requestQuotes(input: LayerZeroQuoteRequest, signal?: AbortSignal): Promise<UnverifiedLayerZeroQuotes> {
      assertApi(typeof input.amount === "bigint" && input.amount > 0n);
      const amount = amountField(String(input.amount));
      const drop = input.dstNativeDropAmount ?? 0n;
      assertApi(typeof drop === "bigint");
      const tolerance = input.feeTolerancePercent ?? 1;
      assertApi(Number.isFinite(tolerance) && tolerance >= 0 && tolerance <= 100);
      const body = {amount, srcChainKey: textField(input.srcChainKey, 128), dstChainKey: textField(input.dstChainKey, 128), srcTokenAddress: textField(input.srcTokenAddress, 256), dstTokenAddress: textField(input.dstTokenAddress, 256), srcWalletAddress: textField(input.srcWalletAddress, 256), dstWalletAddress: textField(input.dstWalletAddress, 256), options: {amountType: "EXACT_SRC_AMOUNT", dstNativeDropAmount: amountField(String(drop)), feeTolerance: {type: "PERCENT", amount: tolerance}}};
      const response = record(await request("quotes", body, signal));
      assertApi(Array.isArray(response.quotes) && response.quotes.length <= 128 && Array.isArray(response.tokens) && response.tokens.length <= 10_000);
      const rejected = response.rejectedQuotes ?? [];
      assertApi(Array.isArray(rejected) && rejected.length <= 128);
      return {quotes: response.quotes, rejectedQuotes: rejected, tokens: response.tokens};
    },
    /** Status is untrusted API evidence, not proof of destination payout. */
    async status(quoteId: string, signal?: AbortSignal): Promise<unknown> {
      assertApi(/^[a-zA-Z0-9_-]{1,256}$/.test(textField(quoteId, 256)));
      return request(`status/${encodeURIComponent(textField(quoteId, 256))}`, undefined, signal);
    },
  };
}
