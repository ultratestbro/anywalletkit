import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, type Hex} from "viem";
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

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const BAL = "0xba100000625a3754423978a60c9317c58a424e3D";
const ME = "0x4444444444444444444444444444444444444444";
const RPC = {1: ["https://rpc.test"]};
const ZERO = "0x0000000000000000000000000000000000000000";
const POOL_A = `0x${"aa".repeat(32)}`;
const POOL_B = `0x${"bb".repeat(32)}`;
const VAULT = parseAbi([
  "function queryBatchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds) returns (int256[] assetDeltas)",
  "function batchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds, int256[] limits, uint256 deadline) payable returns (int256[] assetDeltas)",
  "function WETH() view returns (address)",
]);

interface Stub {
  /** SOR paths to return (tokens as addresses). */
  paths?: {pools: string[]; tokens: string[]; amountIn: string}[];
  /** Output the Vault prices (base units of the last token). */
  vaultOut?: bigint;
  weth?: string;
  receipt?: string | null;
  sorCalls?: string[];
}

function stub(o: Stub = {}): typeof fetch {
  const paths = o.paths ?? [{pools: [POOL_A], tokens: [WETH, USDC], amountIn: "1000000000000000000"}];
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("balancer")) {
      o.sorCalls?.push(body.query);
      return new Response(JSON.stringify({data: {sorGetSwapPaths: {protocolVersion: 2, paths: paths.map((p) => ({pools: p.pools, tokens: p.tokens.map((a) => ({address: a.toLowerCase(), decimals: 18})), inputAmountRaw: p.amountIn, outputAmountRaw: "1", protocolVersion: 2}))}}}));
    }
    if (body.method === "eth_getTransactionReceipt") return new Response(JSON.stringify({result: o.receipt == null ? null : {status: o.receipt}}));
    const data = body.params[0].data as Hex;
    if (data.startsWith("0xad5c4648")) return new Response(JSON.stringify({result: encodeAbiParameters([{type: "address"}], [(o.weth ?? WETH) as Hex])}));
    const call = decodeFunctionData({abi: VAULT, data});
    if (call.functionName !== "queryBatchSwap") throw new Error("unexpected call");
    const [, swaps, assets] = call.args;
    const amountIn = swaps.reduce((s, x) => s + x.amount, 0n);
    const deltas = assets.map((_, i) => (i === Number(swaps[0]!.assetInIndex) ? amountIn : i === assets.length - 1 ? -(o.vaultOut ?? 2_000_000n) : 0n));
    return new Response(JSON.stringify({result: encodeFunctionResult({abi: VAULT, functionName: "queryBatchSwap", result: deltas})}));
  }) as typeof fetch;
}
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
