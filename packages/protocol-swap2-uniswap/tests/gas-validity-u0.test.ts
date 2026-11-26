// U0 (0.4.12), always on: a swap whose gas need exceeds the chain's per-transaction cap, its block gas limit or (Arbitrum
// Nitro) its execution cap can never complete, so it is refused; a padded limit above the gasLimit cap is clamped to
// it, never below the need (UNISWAP-V4-RESEARCH §5.2 U0, decision 7; impact-threshold §6.3). 12 of 805 replayed
// matrix-v8 quotes were above Ethereum's 16,777,216 (EIP-7825); 3 Celo quotes at ~59M exceed its 30M block.
//
// The need is the bare need (quoter gas + 120k router + unwrap/refund) + 5%: EIP-150 forwards 63/64 of the gas into
// each call and the pool's swap runs two calls deep. Round 1 (U0-R1-1, U0-LIVE-1): live on Ethereum, USDC → LINK with
// quoter gas 16,359,404 (bare need 16,479,404) was clamped to 16,777,216 and the built transaction needed 16,825,998
// — mined, out of gas, paid for. The block gas limit is read on its own, optional, and re-read after 10 minutes
// (U0-R1-2, U0-SEC-3, U0-LIVE-3): a node that does not serve it no longer fails every quote on the chain.
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider} from "../src/provider.js";
import {GAS_NEED_PCT, KNOWN_EXECUTION_GAS_CAP, KNOWN_TX_GAS_CAP, boundGasLimit, gasBoundsOf, gasNeedOf} from "../src/impact.js";
import {D, ME, USDC, USDT, rpcStub, type StubOptions} from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NATIVE = "0x0000000000000000000000000000000000000000";
const on = (chainId: number) => ({sourceChain: `eip155:${chainId}`, destChain: `eip155:${chainId}`, destAddress: ME, refundAddress: ME, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"});
const NEEDS = (need: bigint, chainId: number, cap: bigint) => `uniswap: the swap needs ${need} gas, more than chain ${chainId} takes in one transaction (${cap}) — its pools are too thin for this amount`;

/** A provider on `chainId` whose pinned deployment the Ethereum stub answers (an override of the same shape). */
async function quote(chainId: number, stub: StubOptions | typeof fetch, over: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", typeof stub === "function" ? stub : rpcStub(stub));
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const p = uniswapProvider({rpcUrls: {[chainId]: ["https://rpc.test"]}, deployments: {[chainId]: {...D}}, ...config});
  const q = await p.getQuote({...on(chainId), ...over, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }} as never);
  return {p, q, heard};
}

type Req = {jsonrpc: string; id: number; method: string; params: unknown[]};
/** The fixtures' stub with the block read answered by `answer` (a JSON-RPC item, or an HTTP status); every method logged. */
function blockRead(o: StubOptions, answer: object | {http: number} | undefined, methods: string[] = []): typeof fetch {
  const inner = rpcStub(o);
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as Req[];
    methods.push(...batch.map((r) => r.method));
    if (answer && batch.some((r) => r.method === "eth_getBlockByNumber")) {
      if ("http" in answer) return new Response("{}", {status: (answer as {http: number}).http});
      const res = (await (await inner(url, init)).json()) as {id: number}[];
      return new Response(JSON.stringify(res.map((r, i) => (batch[i]!.method === "eth_getBlockByNumber" ? {jsonrpc: "2.0", id: r.id, ...answer} : r))));
    }
    return inner(url, init);
  }) as typeof fetch;
}

describe("gas validity (always on)", () => {
  it("the bounds: Ethereum 2^24 (EIP-7825), Monad 30M, the block's own limit; Nitro's 32M execution cap is never clamped to", () => {
    expect(KNOWN_TX_GAS_CAP).toEqual({1: 16_777_216n, 143: 30_000_000n});
    expect(KNOWN_EXECUTION_GAS_CAP).toEqual({42161: 32_000_000n, 4663: 32_000_000n});
    expect(gasBoundsOf(1, 60_000_000n)).toEqual({limit: 16_777_216n});
    expect(gasBoundsOf(1, 10_000_000n)).toEqual({limit: 10_000_000n});
    expect(gasBoundsOf(143, 150_000_000n)).toEqual({limit: 30_000_000n});
    expect(gasBoundsOf(42220, 30_000_000n)).toEqual({limit: 30_000_000n});
    expect(gasBoundsOf(8453, undefined)).toEqual({});
    expect(gasBoundsOf(1, undefined)).toEqual({limit: 16_777_216n});
    expect(gasBoundsOf(42161, 1n << 50n)).toEqual({limit: 1n << 50n, execution: 32_000_000n});
    expect(gasBoundsOf(4663, undefined)).toEqual({execution: 32_000_000n});
    expect(gasBoundsOf(324, 1n << 50n)).toEqual({limit: 1n << 50n}); // zkSync: its per-transaction limit is an open question
    expect(GAS_NEED_PCT).toBe(105n);
    expect([gasNeedOf(0n), gasNeedOf(100n), gasNeedOf(101n), gasNeedOf(16_479_404n)]).toEqual([0n, 105n, 107n, 17_303_375n]);
    expect(boundGasLimit(100n, 150n, {})).toEqual({gasLimit: 150n});
    expect(boundGasLimit(100n, 150n, {limit: 120n})).toEqual({gasLimit: 120n});
    expect(boundGasLimit(100n, 150n, {limit: 105n})).toEqual({gasLimit: 105n});
    expect(boundGasLimit(100n, 150n, {limit: 104n})).toEqual({refuse: {need: 105n, cap: 104n}});
    expect(boundGasLimit(100n, 150n, {limit: 100n})).toEqual({refuse: {need: 105n, cap: 100n}}); // the bare need fits; the call overhead does not
    expect(boundGasLimit(100n, 150n, {execution: 120n})).toEqual({gasLimit: 150n});
    expect(boundGasLimit(200n, 300n, {limit: 1_000n, execution: 200n})).toEqual({refuse: {need: 210n, cap: 200n}});
    expect(boundGasLimit(100n, 101n, {})).toEqual({gasLimit: 105n}); // never below the need
  });

  it("Celo-like: 39.4M of quoter gas against a 30M block is refused, whatever maxPriceImpactBps is", async () => {
    for (const config of [{}, {maxPriceImpactBps: 500}, {maxPriceImpactBps: 10_000}]) {
      const {q, heard} = await quote(42220, {quoterGas: 39_400_000n, blockGasLimit: 30_000_000n}, {}, config);
      expect(q).toBeNull();
      expect(heard).toEqual([[NEEDS(41_496_000n, 42220, 30_000_000n), {reason: "insufficient_liquidity"}]]); // 39.52M + 5%
    }
  });

  it("Celo (live, U0-LIVE-1): a bare need just under the 30M block is refused, not clamped to a limit the swap runs out of", async () => {
    // 12,450 USDC → CELO was clamped to 30,000,000 and needed 30,396,880.
    const {q, heard} = await quote(42220, {quoterGas: 28_900_000n, blockGasLimit: 30_000_000n});
    expect(q).toBeNull();
    expect(heard).toEqual([[NEEDS(30_471_000n, 42220, 30_000_000n), {reason: "insufficient_liquidity"}]]);
  });

  it("Ethereum: a need under 2^24 whose padded limit is over it is clamped to 16,777,216 (also in the built tx)", async () => {
    const {p, q, heard} = await quote(1, {quoterGas: 11_200_000n}); // need 11.89M; padded 16.92M
    expect(heard).toEqual([]);
    expect(q!.txRequest!.gasLimit).toBe("16777216");
    expect((await p.buildDeposit(q!)).gasLimit).toBe("16777216");
    const under = await quote(1, {quoterGas: 11_100_000n}); // padded 16.77M, under the cap: unchanged
    expect(under.q!.txRequest!.gasLimit).toBe("16770000");
  });

  it("Ethereum: a bare need over 2^24 is refused although the block holds 60M", async () => {
    const {q, heard} = await quote(1, {quoterGas: 16_700_000n});
    expect(q).toBeNull();
    expect(heard).toEqual([[NEEDS(17_661_000n, 1, 16_777_216n), {reason: "insufficient_liquidity"}]]);
  });

  it("Ethereum (U0-R1-1, U0-LIVE-1): a bare need under 2^24 that the call overhead takes over it is refused, never clamped", async () => {
    // Live: USDC → LINK, quoter gas 16,359,404 (bare 16,479,404) was clamped to 16,777,216; the swap needed 16,825,998.
    const link = await quote(1, {quoterGas: 16_359_404n});
    expect(link.q).toBeNull();
    expect(link.heard).toEqual([[NEEDS(17_303_375n, 1, 16_777_216n), {reason: "insufficient_liquidity"}]]);
    // The reviewer's band: 16.4M of quoter gas needs at least 16.4M × (64/63)² ≈ 16.92M.
    const band = await quote(1, {quoterGas: 16_400_000n});
    expect(band.q).toBeNull();
    expect(band.heard[0]![1]).toEqual({reason: "insufficient_liquidity"});
    // Every quoter figure from where the 5% stops fitting up to the old bare-need boundary is refused.
    for (const gas of [15_858_301n, 16_000_000n, 16_140_000n, 16_657_216n]) {
      const {q} = await quote(1, {quoterGas: gas});
      expect([gas, q]).toEqual([gas, null]);
    }
    const fits = await quote(1, {quoterGas: 15_858_300n}); // (15,858,300 + 120,000) × 1.05 = 16,777,215
    expect(fits.q!.txRequest!.gasLimit).toBe("16777216");
  });

  it("the unwrap's 40k counts in the need", async () => {
    const exact = (16_777_216n * 100n) / GAS_NEED_PCT - 120_000n - 40_000n; // the largest bare need whose +5% fits
    const fits = await quote(1, {quoterGas: exact}, {destToken: NATIVE});
    expect(fits.q!.txRequest!.gasLimit).toBe("16777216");
    const over = await quote(1, {quoterGas: exact + 1n}, {destToken: NATIVE});
    expect(over.heard[0]![0]).toMatch(/^uniswap: the swap needs 16777217 gas, more than chain 1 takes/);
    const erc20 = await quote(1, {quoterGas: exact + 1n}); // the same quoter gas without the unwrap fits
    expect(erc20.q!.txRequest!.gasLimit).toBe("16777216");
  });

  it("Monad: the 16.25M limit of the trigger case is under the 30M cap and stays as it was; a need over 30M is refused", async () => {
    const {q} = await quote(143, {quoterGas: 10_763_852n, blockGasLimit: 150_000_000n});
    expect(q!.txRequest!.gasLimit).toBe("16265778"); // 10,763,852 × 1.5 + 120,000
    const clamp = await quote(143, {quoterGas: 20_000_000n, blockGasLimit: 150_000_000n});
    expect(clamp.q!.txRequest!.gasLimit).toBe("30000000");
    const over = await quote(143, {quoterGas: 29_900_000n, blockGasLimit: 150_000_000n});
    expect(over.heard[0]).toEqual([NEEDS(31_521_000n, 143, 30_000_000n), {reason: "insufficient_liquidity"}]);
    // Live, 62,000 MON → AUSD ran in 3.5% over its bare need: within 5% of the cap is refused (Monad charges the limit).
    const band = await quote(143, {quoterGas: 28_500_000n, blockGasLimit: 150_000_000n});
    expect(band.heard[0]).toEqual([NEEDS(30_051_000n, 143, 30_000_000n), {reason: "insufficient_liquidity"}]);
  });

  it("Arbitrum One and Robinhood Chain (U0-SEC-2, U0-LIVE-2): an execution need over Nitro's 32M is refused despite the 2^50 header", async () => {
    const usdc = {sourceToken: USDC, sourceDecimals: 6}; // the stub's token by address (4663 lists no USDC)
    for (const chainId of [42161, 4663]) {
      const {q, heard} = await quote(chainId, {quoterGas: 40_000_000n, blockGasLimit: 1n << 50n}, usdc);
      expect(q).toBeNull();
      expect(heard).toEqual([[NEEDS(42_126_000n, chainId, 32_000_000n), {reason: "insufficient_liquidity"}]]);
      // Live, USDC → cbBTC $200k was offered with gasLimit 121,971,253 (a bare need of about 81M).
      const cbbtc = await quote(chainId, {quoterGas: 81_234_168n, blockGasLimit: 1n << 50n}, usdc);
      expect(cbbtc.q).toBeNull();
      // Under the cap: the padded limit stands even above 32M (it also pays the L1 gas), never clamped to the execution cap.
      const ok = await quote(chainId, {quoterGas: 22_000_000n, blockGasLimit: 1n << 50n}, usdc);
      expect(ok.heard).toEqual([]);
      expect(ok.q!.txRequest!.gasLimit).toBe("33120000");
      // The cap is known, not read: a node that gives no block still refuses over it.
      const noBlock = await quote(chainId, {quoterGas: 40_000_000n, blockGasLimit: null}, usdc);
      expect(noBlock.q).toBeNull();
    }
  });

  it("a block below the known cap caps lower; a block without a gasLimit leaves only the known cap", async () => {
    const low = await quote(1, {quoterGas: 9_000_000n, blockGasLimit: 10_000_000n});
    expect(low.q!.txRequest!.gasLimit).toBe("10000000");
    const none = await quote(8453, {quoterGas: 50_000_000n, blockGasLimit: null}); // no known cap, no block limit: as 0.4.11
    expect(none.q!.txRequest!.gasLimit).toBe("75120000");
    const known = await quote(1, {quoterGas: 12_000_000n, blockGasLimit: null});
    expect(known.q!.txRequest!.gasLimit).toBe("16777216");
  });

  it("a quoter that does not measure gas: no limit and no gas refusal, as before", async () => {
    const {q, heard} = await quote(1, {quoterGas: 0n, blockGasLimit: 1n});
    expect(heard).toEqual([]);
    expect(q!.txRequest!.gasLimit).toBeUndefined();
  });

  it("a block read the node refuses never fails the quote (U0-R1-2, U0-SEC-3, U0-LIVE-3): only the known caps apply", async () => {
    const answers: Array<object | {http: number}> = [
      {error: {code: -32601, message: "the method eth_getBlockByNumber does not exist/is not available"}},
      {error: {code: -32001, message: "method not whitelisted"}},
      {error: {code: -32603, message: "response size exceeded"}},
      {error: {code: -32000, message: "header not found"}},
      {error: {code: -32007, message: "50/second request limit reached"}},
      {result: null},
      {result: {number: "0x1", gasLimit: "0x"}},
      {http: 405},
    ];
    for (const config of [{}, {maxPriceImpactBps: 500}]) {
      for (const answer of answers) {
        const methods: string[] = [];
        const {q, heard} = await quote(1, blockRead({quoterGas: 90_000n}, answer, methods), {}, config);
        expect([answer, heard]).toEqual([answer, []]);
        expect(q).toMatchObject({destAmount: "1000000", txRequest: {gasLimit: "255000"}});
        expect(methods.filter((m) => m === "eth_getBlockByNumber")).toHaveLength(1); // one pass, not retried
        // The known cap still applies: 12M of quoter gas is clamped to 2^24 on Ethereum...
        const big = await quote(1, blockRead({quoterGas: 12_000_000n}, answer), {}, config);
        expect(big.q!.txRequest!.gasLimit).toBe("16777216");
        // ...and a chain with no known cap quotes as 0.4.11 did.
        const base = await quote(8453, blockRead({quoterGas: 50_000_000n}, answer), {}, config);
        expect(base.q!.txRequest!.gasLimit).toBe("75120000");
      }
    }
  });

  it("the deployment check is 0.4.11's four calls; the block read goes on its own, after it", async () => {
    const batches: string[][] = [];
    const inner = rpcStub({quoterGas: 90_000n});
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      batches.push((JSON.parse(String(init?.body)) as Req[]).map((c) => c.method));
      return inner(url, init);
    }) as typeof fetch);
    expect(await uniswapProvider({rpcUrls: {1: ["https://rpc.test"]}}).getQuote(on(1))).not.toBeNull();
    expect(batches[0]).toEqual(["eth_call", "eth_call", "eth_call", "eth_call"]);
    expect(batches[1]).toEqual(["eth_getBlockByNumber"]);
  });

  it("the block gas limit is read once per chain and trusted for 10 minutes; a failed read is tried again after 1 minute", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(Date.UTC(2026, 10, 26));
    const methods: string[] = [];
    let answer: object | undefined;
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => blockRead({quoterGas: 90_000n}, answer, methods)(url, init)) as typeof fetch);
    const p = uniswapProvider({rpcUrls: {1: ["https://rpc.test"]}});
    const reads = () => methods.filter((m) => m === "eth_getBlockByNumber").length;
    for (let i = 0; i < 3; i++) expect((await p.getQuote(on(1)))!.txRequest!.gasLimit).toBe("255000");
    expect(reads()).toBe(1);
    vi.setSystemTime(Date.now() + 10 * 60_000 - 1);
    await p.getQuote(on(1));
    expect(reads()).toBe(1);
    vi.setSystemTime(Date.now() + 1);
    await p.getQuote(on(1));
    expect(reads()).toBe(2);
    // A failed read: tried again after a minute, not after ten.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    answer = {error: {code: -32601, message: "method not found"}};
    await p.getQuote(on(1));
    expect(reads()).toBe(3);
    answer = undefined;
    vi.setSystemTime(Date.now() + 59_999);
    await p.getQuote(on(1));
    expect(reads()).toBe(3);
    vi.setSystemTime(Date.now() + 1);
    await p.getQuote(on(1));
    expect(reads()).toBe(4);
  });

  it("one wrong block gas limit is not kept (U0-SEC-3): after 10 minutes the chain's own limit is read again", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(Date.UTC(2026, 10, 26));
    vi.stubGlobal("fetch", rpcStub({quoterGas: 90_000n, blockGasLimit: 100_000n}));
    const p = uniswapProvider({rpcUrls: {1: ["https://rpc.test"]}});
    const heard: string[] = [];
    expect(await p.getQuote({...on(1), onRefusal: (t: string) => { heard.push(t); }})).toBeNull();
    expect(heard).toEqual([NEEDS(220_500n, 1, 100_000n)]);
    vi.stubGlobal("fetch", rpcStub({quoterGas: 90_000n}));
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect((await p.getQuote(on(1)))!.txRequest!.gasLimit).toBe("255000");
  });
});
