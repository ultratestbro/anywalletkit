// U0 (0.4.12), always on: a swap whose bare gas need (quoter gas + 120k router + unwrap/refund, no headroom) exceeds the
// chain's per-transaction cap or block gas limit can never be mined, so it is refused; a padded limit above the cap is
// clamped to it, never below the need (UNISWAP-V4-RESEARCH §5.2 U0, decision 7; impact-threshold §6.3). 12 of 805
// replayed matrix-v8 quotes were above Ethereum's 16,777,216 (EIP-7825); 3 Celo quotes at ~59M exceed its 30M block.
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider} from "../src/provider.js";
import {KNOWN_TX_GAS_CAP, boundGasLimit, gasCapOf} from "../src/impact.js";
import {D, ME, USDT, rpcStub, type StubOptions} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const NATIVE = "0x0000000000000000000000000000000000000000";
const on = (chainId: number) => ({sourceChain: `eip155:${chainId}`, destChain: `eip155:${chainId}`, destAddress: ME, refundAddress: ME, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"});

/** A provider on `chainId` whose pinned deployment the Ethereum stub answers (an override of the same shape). */
async function quote(chainId: number, stub: StubOptions, over: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", rpcStub(stub));
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const p = uniswapProvider({rpcUrls: {[chainId]: ["https://rpc.test"]}, deployments: {[chainId]: {...D}}, ...config});
  const q = await p.getQuote({...on(chainId), ...over, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }} as never);
  return {p, q, heard};
}

describe("gas validity (always on)", () => {
  it("the caps: Ethereum 2^24 (EIP-7825), Monad 30M; elsewhere the block's own limit", () => {
    expect(KNOWN_TX_GAS_CAP).toEqual({1: 16_777_216n, 143: 30_000_000n});
    expect(gasCapOf(1, 60_000_000n)).toBe(16_777_216n);
    expect(gasCapOf(1, 10_000_000n)).toBe(10_000_000n);
    expect(gasCapOf(143, 150_000_000n)).toBe(30_000_000n);
    expect(gasCapOf(42220, 30_000_000n)).toBe(30_000_000n);
    expect(gasCapOf(8453, undefined)).toBeUndefined();
    expect(gasCapOf(1, undefined)).toBe(16_777_216n);
    expect(boundGasLimit(100n, 150n, undefined)).toEqual({gasLimit: 150n});
    expect(boundGasLimit(100n, 150n, 120n)).toEqual({gasLimit: 120n});
    expect(boundGasLimit(100n, 150n, 100n)).toEqual({gasLimit: 100n});
    expect(boundGasLimit(101n, 150n, 100n)).toEqual({refuse: {need: 101n, cap: 100n}});
  });

  it("Celo-like: 39.4M of quoter gas against a 30M block is refused, whatever maxPriceImpactBps is", async () => {
    for (const config of [{}, {maxPriceImpactBps: 500}, {maxPriceImpactBps: 10_000}]) {
      const {q, heard} = await quote(42220, {quoterGas: 39_400_000n, blockGasLimit: 30_000_000n}, {}, config);
      expect(q).toBeNull();
      expect(heard).toEqual([["uniswap: the swap needs 39520000 gas, more than chain 42220 takes in one transaction (30000000) — its pools are too thin for this amount", {reason: "insufficient_liquidity"}]]);
    }
  });

  it("Ethereum: a need under 2^24 whose padded limit is over it is clamped to 16,777,216 (also in the built tx)", async () => {
    const {p, q, heard} = await quote(1, {quoterGas: 11_200_000n}); // need 11.32M; padded 16.92M
    expect(heard).toEqual([]);
    expect(q!.txRequest!.gasLimit).toBe("16777216");
    expect((await p.buildDeposit(q!)).gasLimit).toBe("16777216");
    const under = await quote(1, {quoterGas: 11_100_000n}); // padded 16.77M, under the cap: unchanged
    expect(under.q!.txRequest!.gasLimit).toBe("16770000");
  });

  it("Ethereum: a bare need over 2^24 is refused although the block holds 60M", async () => {
    const {q, heard} = await quote(1, {quoterGas: 16_700_000n});
    expect(q).toBeNull();
    expect(heard).toEqual([["uniswap: the swap needs 16820000 gas, more than chain 1 takes in one transaction (16777216) — its pools are too thin for this amount", {reason: "insufficient_liquidity"}]]);
  });

  it("the unwrap's 40k counts in the need", async () => {
    const exact = 16_777_216n - 120_000n - 40_000n;
    const fits = await quote(1, {quoterGas: exact}, {destToken: NATIVE});
    expect(fits.q!.txRequest!.gasLimit).toBe("16777216");
    const over = await quote(1, {quoterGas: exact + 1n}, {destToken: NATIVE});
    expect(over.heard[0]![0]).toMatch(/^uniswap: the swap needs 16777217 gas, more than chain 1 takes/);
  });

  it("Monad: the 16.25M limit of the trigger case is under the 30M cap and stays as it was; a need over 30M is refused", async () => {
    const {q} = await quote(143, {quoterGas: 10_763_852n, blockGasLimit: 150_000_000n});
    expect(q!.txRequest!.gasLimit).toBe("16265778"); // 10,763,852 × 1.5 + 120,000
    const clamp = await quote(143, {quoterGas: 20_000_000n, blockGasLimit: 150_000_000n});
    expect(clamp.q!.txRequest!.gasLimit).toBe("30000000");
    const over = await quote(143, {quoterGas: 29_900_000n, blockGasLimit: 150_000_000n});
    expect(over.heard[0]).toEqual(["uniswap: the swap needs 30020000 gas, more than chain 143 takes in one transaction (30000000) — its pools are too thin for this amount", {reason: "insufficient_liquidity"}]);
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

  it("the block gas limit is read once per chain, with the deployment check", async () => {
    const stub = rpcStub({quoterGas: 90_000n});
    const reads: string[] = [];
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      for (const c of JSON.parse(String(init?.body)) as {method: string}[]) reads.push(c.method);
      return stub(url, init);
    }) as typeof fetch);
    const p = uniswapProvider({rpcUrls: {1: ["https://rpc.test"]}});
    for (let i = 0; i < 3; i++) expect((await p.getQuote(on(1)))!.txRequest!.gasLimit).toBe("255000");
    expect(reads.filter((m) => m === "eth_getBlockByNumber")).toHaveLength(1);
  });
});
