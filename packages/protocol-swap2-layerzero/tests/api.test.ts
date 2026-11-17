import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createLayerZeroDiscovery, LayerZeroApiError} from "../src/index.js";
import {createLayerZeroServerApi} from "../src/server.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/public.json", import.meta.url), "utf8")) as {captures: {url: string; status: number; body: unknown}[]};
const input = {srcChainKey: "base", dstChainKey: "arbitrum", srcTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", dstTokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", srcWalletAddress: "0x1111111111111111111111111111111111111111", dstWalletAddress: "0x2222222222222222222222222222222222222222", amount: (1n << 64n) + 1n};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("LayerZero public discovery", () => {
  it("replays the real public catalogs without an API key or execution authority", async () => {
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(init?.headers).not.toHaveProperty("x-api-key");
      const captured = fixture.captures.find((c) => new URL(c.url).pathname === new URL(String(url)).pathname)!;
      expect(captured.status).toBe(200);
      return Response.json(captured.body);
    };
    const api = createLayerZeroDiscovery({fetchImpl});
    const chains = await api.chains();
    expect(chains.items).toHaveLength(96);
    expect(chains.items.find((c) => c.chainKey === "base")).toMatchObject({chainType: "EVM", chainId: 8453});
    expect(chains.items.find((c) => c.chainKey === "stellar")?.chainId).toBeTypeOf("string");
    const tokens = await api.tokens({from: {chainKey: "base", tokenAddress: input.srcTokenAddress}});
    expect(tokens.items).toHaveLength(1587);
    expect(tokens.items.find((t) => t.address.toLowerCase() === input.dstTokenAddress.toLowerCase())?.decimals).toBe(6);
    expect((await api.metadata()).solana?.transferDelegate).toBeUndefined();
    expect(api).not.toHaveProperty("execute");
  });

  it("encodes the opaque cursor and source pair without following pagination automatically", async () => {
    let count = 0;
    const api = createLayerZeroDiscovery({fetchImpl: async (url) => {
      count++;
      const q = new URL(String(url)).searchParams;
      expect(q.get("pagination[nextToken]")).toBe("cursor&secret=value");
      expect(q.get("transferrableFromChainKey")).toBe("base");
      expect(q.get("transferrableFromTokenAddress")).toBe(input.srcTokenAddress);
      expect(q.has("secret")).toBe(false);
      return Response.json({tokens: [], pagination: {nextToken: "next"}});
    }});
    expect(await api.tokens({nextToken: "cursor&secret=value", from: {chainKey: "base", tokenAddress: input.srcTokenAddress}})).toEqual({items: [], nextToken: "next"});
    expect(count).toBe(1);
  });

  it("refuses malformed amounts/decimals and does not turn metadata into approval pins", async () => {
    const token = {chainKey: "base", address: input.srcTokenAddress, decimals: 6.5, symbol: "USDC", name: "USD Coin", isSupported: true};
    const api = createLayerZeroDiscovery({fetchImpl: async () => Response.json({tokens: [token], pagination: {}})});
    await expect(api.tokens()).rejects.toMatchObject({code: "schema"});
    expect(api).not.toHaveProperty("spenders");
  });
});

describe("API transport and server boundary (synthetic responses)", () => {
  it("retries only read-only requests after Retry-After", async () => {
    let count = 0;
    const api = createLayerZeroDiscovery({fetchImpl: async () => ++count === 1 ? new Response("rate limit", {status: 429, headers: {"retry-after": "0"}}) : Response.json({tokens: [], pagination: {}})});
    expect(await api.tokens()).toEqual({items: []});
    expect(count).toBe(2);
  });

  it("honors cancellation during backoff and cleans up the request timer", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const fetchImpl = vi.fn(async () => new Response("", {status: 429, headers: {"retry-after": "10"}}));
    const pending = createLayerZeroDiscovery({fetchImpl}).tokens({signal: abort.signal});
    const checked = expect(pending).rejects.toMatchObject({code: "aborted"});
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    await checked;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the total deadline and never echoes transport credentials", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("secret-api-key")), {once: true}));
    const pending = createLayerZeroServerApi({apiKey: "secret-api-key", timeoutMs: 100, fetchImpl}).status("quote_1");
    const checked = expect(pending).rejects.toEqual(new LayerZeroApiError("timeout"));
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes bigint base units unchanged and keeps raw quotes explicitly unverified", async () => {
    const api = createLayerZeroServerApi({apiKey: "test-key", fetchImpl: async (_url, init) => {
      expect(init?.headers).toHaveProperty("x-api-key", "test-key");
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body));
      expect(body.amount).toBe("18446744073709551617");
      expect(body.options).toEqual({amountType: "EXACT_SRC_AMOUNT", dstNativeDropAmount: "0", feeTolerance: {type: "PERCENT", amount: 1}});
      return Response.json({quotes: [{userSteps: [{type: "UNKNOWN"}]}], tokens: []});
    }});
    expect((await api.requestQuotes(input)).quotes).toHaveLength(1);
    expect(api).not.toHaveProperty("execute");
    expect(api).not.toHaveProperty("submitSignature");
    expect(JSON.stringify(api)).not.toContain("test-key");
  });

  it("does not retry POST or expose upstream bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret-key", {status: 503, headers: {"retry-after": "0"}}));
    const api = createLayerZeroServerApi({apiKey: "secret-key", fetchImpl});
    await expect(api.requestQuotes(input)).rejects.toEqual(new LayerZeroApiError("http", 503));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid input before transport and confines status to a quote identifier", async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    const api = createLayerZeroServerApi({apiKey: "key", fetchImpl});
    for (const amount of [0n, -1n, 1n << 256n]) await expect(api.requestQuotes({...input, amount})).rejects.toMatchObject({code: "schema"});
    await expect(api.requestQuotes({...input, feeTolerancePercent: NaN})).rejects.toMatchObject({code: "schema"});
    await expect(api.status("../metadata")).rejects.toMatchObject({code: "schema"});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects browser/native construction and unsafe endpoint configuration", () => {
    vi.stubGlobal("window", {});
    expect(() => createLayerZeroServerApi({apiKey: "key"})).toThrow("server-only");
    vi.unstubAllGlobals();
    for (const baseUrl of ["http://api.test", "https://user:key@api.test", "https://api.test?key=abc", "https://api.test#fragment"]) expect(() => createLayerZeroDiscovery({baseUrl})).toThrow("config");
  });
});
