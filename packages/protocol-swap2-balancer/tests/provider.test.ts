import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, type Hex} from "viem";
import {BAL, ME, POOL_A, POOL_B, RPC, USDC, VAULT, WETH, ZERO, stub} from "./fixtures.js";
import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {BALANCER_V2_VAULT, balancerProvider} from "../src/provider.js";
import {BalancerSwap2Protocol} from "../src/protocol.js";

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

afterEach(() => vi.unstubAllGlobals());

const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};
const decode = (data: string) => decodeFunctionData({abi: VAULT, data: data as Hex});

describe("Balancer v2 provider", () => {
  it("prices the SOR path on the Vault and builds batchSwap with limits to the recipient", async () => {
    vi.stubGlobal("fetch", stub({paths: [{pools: [POOL_A], tokens: [BAL, USDC], amountIn: "1000000000000000000"}], vaultOut: 2_000_000n}));
    const q = await balancerProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "AAVE", destToken: USDC, amountIn: "1000000000000000000"}).catch(() => null);
    // AAVE is in the catalog but the stub path starts at BAL → mismatch is refused, by name:
    expect(q).toBeNull();
    let why = "";
    vi.stubGlobal("fetch", stub({vaultOut: 2_000_000n}));
    const ok = await balancerProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000", onRefusal: (r) => { why = r; }});
    expect(why).toBe("");
    expect(ok).toMatchObject({provider: "balancer", destAmount: "2000000", minDestAmount: "1990000", txRequest: {to: BALANCER_V2_VAULT, value: "0", approvalAddress: BALANCER_V2_VAULT}});
    const call = decode(ok!.txRequest!.data!);
    expect(call.functionName).toBe("batchSwap");
    const [kind, swaps, assets, funds, limits] = call.args as unknown as [number, {poolId: string; amount: bigint}[], string[], {sender: string; recipient: string}, bigint[]];
    expect(kind).toBe(0);
    expect(swaps).toEqual([expect.objectContaining({poolId: POOL_A, amount: 10n ** 18n})]);
    expect(assets).toEqual([WETH, USDC]);
    expect(funds).toMatchObject({sender: ME, recipient: ME});
    expect(limits).toEqual([10n ** 18n, -1_990_000n]);
  });

  it("native in: the Vault's ETH sentinel (address 0) with value, no approval", async () => {
    vi.stubGlobal("fetch", stub());
    const q = await balancerProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000000"});
    expect(q!.txRequest).toMatchObject({value: "1000000000000000000"});
    expect(q!.txRequest!.approvalAddress).toBeUndefined();
    expect((decode(q!.txRequest!.data!).args as unknown as [number, unknown, string[]])[2]).toEqual([ZERO, USDC]);
  });

  it("names its refusals: floor breach, wrong Vault WETH, no route, cross-chain", async () => {
    const reasons: string[] = [];
    const on = (r: string) => reasons.push(r);
    vi.stubGlobal("fetch", stub({vaultOut: 2_000_000n}));
    await balancerProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000", minAmountOut: "1999000", onRefusal: on});
    vi.stubGlobal("fetch", stub({weth: "0x000000000000000000000000000000000000dEaD"}));
    await balancerProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000", onRefusal: on});
    vi.stubGlobal("fetch", stub({paths: []}));
    await balancerProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000", onRefusal: on});
    await balancerProvider({rpcUrls: RPC}).getQuote({...base, destChain: "eip155:10", sourceToken: "WETH", destToken: USDC, amountIn: "1", onRefusal: on});
    expect(reasons).toEqual([
      "balancer: floor breach (min=1990000 < floor=1999000)",
      "balancer: the Vault on chain 1 is not the pinned deployment — refusing",
      "balancer: no Balancer v2 pool route for this pair and amount",
      "balancer: same-chain swaps only",
    ]);
  });

  it("refuses an SOR split that does not add up to the amount", async () => {
    vi.stubGlobal("fetch", stub({paths: [{pools: [POOL_A], tokens: [WETH, USDC], amountIn: "1"}]}));
    let why = "";
    expect(await balancerProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000", onRefusal: (r) => { why = r; }})).toBeNull();
    expect(why).toBe("balancer: the SOR split does not add up to the amount");
  });

  it("multi-hop and split paths share one asset list; preflight re-prices the signed batch", async () => {
    vi.stubGlobal("fetch", stub({paths: [{pools: [POOL_A, POOL_B], tokens: [WETH, BAL, USDC], amountIn: "600000000000000000"}, {pools: [POOL_B], tokens: [WETH, USDC], amountIn: "400000000000000000"}]}));
    const p = balancerProvider({rpcUrls: RPC});
    const q = await p.getQuote({...base, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000"});
    const [, swaps, assets] = decode(q!.txRequest!.data!).args as unknown as [number, {assetInIndex: bigint; assetOutIndex: bigint; amount: bigint}[], string[]];
    expect(assets).toEqual([WETH, BAL, USDC]);
    expect(swaps.map((s) => [Number(s.assetInIndex), Number(s.assetOutIndex), s.amount])).toEqual([[0, 1, 6n * 10n ** 17n], [1, 2, 0n], [0, 2, 4n * 10n ** 17n]]);
    await expect(p.preflightDeposit!(q!, await p.buildDeposit(q!))).resolves.toBeUndefined();
    vi.stubGlobal("fetch", stub({vaultOut: 1_000_000n}));
    await expect(p.preflightDeposit!(q!, await p.buildDeposit(q!))).rejects.toThrow(/price moved — the pools now pay 1000000, under your minimum 1990000/);
  });

  it("tracks by receipt", async () => {
    const p = balancerProvider({rpcUrls: RPC});
    vi.stubGlobal("fetch", stub({receipt: "0x1"}));
    expect(await p.trackIntent({intentId: "balancer:1", sourceTxHash: "0xab"})).toEqual({state: "completed", destTxHash: "0xab"});
    vi.stubGlobal("fetch", stub({receipt: "0x0"}));
    expect(await p.trackIntent({intentId: "balancer:1", sourceTxHash: "0xab"})).toEqual({state: "failed"});
  });
});

describeProtocolModule("protocol-swap2-balancer", {
  type: "swap2",
  activity,
  Protocol: BalancerSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true, rpcUrls: RPC},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

describeProtocolBehaviour("protocol-swap2-balancer", {
  type: "swap2",
  Protocol: BalancerSwap2Protocol,
  config: {fromChain: "eip155:1", rpcUrls: RPC},
  fixtures: [
    {name: "WETH → USDC (exact approve to the Vault, then batchSwap)", options: {fromToken: "WETH", toToken: USDC, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 18n, minAmountOut: 1_980_000n}, fetch: stub(), account: {address: ME}, own: [ME], spender: BALANCER_V2_VAULT, sourceToken: WETH},
    {name: "ETH → USDC (native value, no approval)", options: {fromToken: "ETH", toToken: USDC, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 18n, minAmountOut: 1_980_000n}, fetch: stub(), account: {address: ME}, own: [ME]},
  ],
});
