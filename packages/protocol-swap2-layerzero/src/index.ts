import {apiTransport, assertApi, record, textField, type LayerZeroApiConfig} from "./transport.js";
export {LayerZeroApiError, type LayerZeroApiConfig, type LayerZeroApiErrorCode} from "./transport.js";

export interface LayerZeroCurrency {chainKey: string; address: string; decimals: number; symbol: string; name: string}
export interface LayerZeroChain {chainKey: string; name: string; shortName: string; chainType: string; chainId?: number | string; nativeCurrency: LayerZeroCurrency}
export interface LayerZeroToken extends LayerZeroCurrency {isSupported: boolean}
export interface LayerZeroPage<T> {items: T[]; nextToken?: string}
export type LayerZeroMetadata = Record<string, {multicall?: string; transferDelegate?: string}>;
function currency(value: unknown): LayerZeroCurrency {
  const v = record(value);
  assertApi(Number.isInteger(v.decimals) && (v.decimals as number) >= 0 && (v.decimals as number) <= 255);
  return {chainKey: textField(v.chainKey, 128), address: textField(v.address, 256), decimals: v.decimals as number, symbol: textField(v.symbol, 128), name: textField(v.name)};
}
function page<T>(value: unknown, key: string, parse: (v: unknown) => T): LayerZeroPage<T> {
  const v = record(value), pagination = record(v.pagination);
  assertApi(Array.isArray(v[key]) && v[key].length <= 10_000);
  return {items: v[key].map(parse), ...(pagination.nextToken === undefined ? {} : {nextToken: textField(pagination.nextToken, 8192)})};
}
function cursor(nextToken?: string) { const q = new URLSearchParams(); if (nextToken !== undefined) q.set("pagination[nextToken]", textField(nextToken, 8192)); return q; }

/** Public catalogs are discovery hints. They confer no execution/approval authority. */
export function createLayerZeroDiscovery(config: LayerZeroApiConfig = {}) {
  const request = apiTransport(config);
  return {
    async chains(options: {nextToken?: string; signal?: AbortSignal} = {}): Promise<LayerZeroPage<LayerZeroChain>> {
      return page(await request("chains", cursor(options.nextToken), options.signal), "chains", (value) => {
        const v = record(value), nativeCurrency = currency(v.nativeCurrency);
        const chainKey = textField(v.chainKey, 128), chainType = textField(v.chainType, 128);
        assertApi(nativeCurrency.chainKey === chainKey);
        if (v.chainId !== undefined) assertApi(typeof v.chainId === "string" ? v.chainId.length > 0 && v.chainId.length <= 256 : Number.isSafeInteger(v.chainId));
        if (chainType === "EVM") assertApi(Number.isSafeInteger(v.chainId) && (v.chainId as number) > 0);
        return {chainKey, chainType, name: textField(v.name), shortName: textField(v.shortName), nativeCurrency, ...(v.chainId === undefined ? {} : {chainId: v.chainId as number | string})};
      });
    },
    async tokens(options: {from?: {chainKey: string; tokenAddress: string}; nextToken?: string; signal?: AbortSignal} = {}): Promise<LayerZeroPage<LayerZeroToken>> {
      const q = cursor(options.nextToken);
      if (options.from) { q.set("transferrableFromChainKey", textField(options.from.chainKey, 128)); q.set("transferrableFromTokenAddress", textField(options.from.tokenAddress, 256)); }
      return page(await request("tokens", q, options.signal), "tokens", (value) => { const v = record(value); assertApi(typeof v.isSupported === "boolean"); return {...currency(v), isSupported: v.isSupported}; });
    },
    async metadata(signal?: AbortSignal): Promise<LayerZeroMetadata> {
      const v = record(await request("metadata", undefined, signal));
      assertApi(Object.keys(v).length <= 1000);
      return Object.fromEntries(Object.entries(v).map(([key, value]) => {
        const deployments = record(record(value).deployments);
        const address = (name: string) => deployments[name] === undefined ? undefined : textField(record(deployments[name]).address, 256);
        const multicall = address("multicall"), transferDelegate = address("transferDelegate");
        return [textField(key, 128), {...(multicall ? {multicall} : {}), ...(transferDelegate ? {transferDelegate} : {})}];
      }));
    },
  };
}
