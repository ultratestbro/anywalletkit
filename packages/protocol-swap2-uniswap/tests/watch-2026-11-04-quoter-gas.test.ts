// Watch 2026-11-04 (pinned-deprecated-quoter-gas0): Unichain, Monad, Linea and X Layer pinned Uniswap's deprecated
// `Quoter`, which quotes the right amounts but always reports gasEstimate 0 — and the swap's gasLimit was derived from
// it: 120k (160k with an unwrap), the router overhead alone. Simulation runs without a gas cap, so the swap passed it,
// was broadcast with that limit and ran out of gas on chain.
import {afterEach, describe, expect, it, vi} from "vitest";
import {uniswapProvider} from "../src/provider.js";
import {UNISWAP_V3} from "../src/addresses.js";
import {ME, RPC, USDC, USDT, rpcStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};
const NATIVE = "0x0000000000000000000000000000000000000000";
/** The least a live single-pool swap through SwapRouter02 used (eth_estimateGas, 2026-11-04, Unichain USDC → ETH);
 *  the others on Unichain, Monad, Linea and X Layer took 170k–275k — each above the 120k / 160k a gas-0 quote set. */
const REAL_SWAP_GAS = 168_877n;

describe("uniswap quoter gas (watch 2026-11-04)", () => {
  it("a quoter reporting gas 0 leaves the limit to the wallet, never the bare router overhead", async () => {
    const p = uniswapProvider({rpcUrls: RPC});
    const cases = [
      [{...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"}, {}],
      [{...base, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000"}, {}],
      [{...base, sourceToken: "USDC", destToken: NATIVE, amountIn: "1000000"}, {}],
      [{...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"}, {byFee: {}, multiHop: 1_000_000n}],
    ] as const;
    for (const [params, stub] of cases) {
      vi.stubGlobal("fetch", rpcStub({...stub, quoterGas: 0n}));
      const q = await p.getQuote(params);
      expect(q).not.toBeNull();
      expect(q!.txRequest!.gasLimit).toBeUndefined();
      const tx = await p.buildDeposit!(q!);
      expect(tx.gasLimit).toBeUndefined();
      expect(tx).toMatchObject({to: UNISWAP_V3[1]!.router, data: q!.txRequest!.data});
    }
  });

  it("a figure under one pool's least cost per pool is no figure either (two pools, 30k)", async () => {
    vi.stubGlobal("fetch", rpcStub({byFee: {}, multiHop: 1_000_000n, quoterGas: 30_000n}));
    const q = await uniswapProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"});
    expect(q!.providerData!.path).toMatch(/^0x/);
    expect(q!.txRequest!.gasLimit).toBeUndefined();
  });

  it("a measured quoter figure still sets a limit above a real swap's need", async () => {
    vi.stubGlobal("fetch", rpcStub({quoterGas: 90_000n}));
    const p = uniswapProvider({rpcUrls: RPC});
    const q = await p.getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"});
    expect(q!.txRequest!.gasLimit).toBe("255000");
    expect(BigInt(q!.txRequest!.gasLimit!)).toBeGreaterThan(REAL_SWAP_GAS);
    expect((await p.buildDeposit!(q!)).gasLimit).toBe("255000");
    const out = await p.getQuote({...base, sourceToken: "USDC", destToken: NATIVE, amountIn: "1000000"});
    expect(out!.txRequest!.gasLimit).toBe("295000");
  });

  it("refuses a quoter without WETH9() — a deprecated Quoter no longer passes the deployment check", async () => {
    vi.stubGlobal("fetch", rpcStub({quoterNoWeth: true}));
    let why = "";
    expect(await uniswapProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000", onRefusal: (r) => { why = r; }})).toBeNull();
    expect(why).toMatch(/do not match the pinned deployment/);
  });

  it("Unichain, Monad, Linea and X Layer pin the active QuoterV2, not the deprecated Quoter", () => {
    expect(UNISWAP_V3[130]!.quoter).toBe("0x385A5cf5F83e99f7BB2852b6A19C3538b9FA7658");
    expect(UNISWAP_V3[143]!.quoter).toBe("0x661E93cca42AfacB172121EF892830cA3b70F08d");
    expect(UNISWAP_V3[59144]!.quoter).toBe("0x42bE4D6527829FeFA1493e1fb9F3676d2425C3C1");
    expect(UNISWAP_V3[196]!.quoter).toBe("0xD1b797D92d87B688193A2B976eFc8D577D204343");
    const deprecated = ["0x565ac8c7863d9bb16d07e809ff49fe5cd467634c", "0x2d01411773c8c24805306e89a41f7855c3c4fe65", "0x58ead433ea99708604c4dd7c9b7e80c70976e202", "0x976183ac3d09840d243a88c0268badb3b3e3259f"];
    for (const d of Object.values(UNISWAP_V3)) {
      expect(deprecated).not.toContain(d.quoter.toLowerCase());
      expect(Object.keys(d)).not.toContain("quoterWeth");
    }
  });
});
