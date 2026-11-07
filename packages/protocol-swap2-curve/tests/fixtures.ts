// Test tables and a JSON-RPC stub for Curve. The deployments are the shipped pins with the code hash swapped for the
// stub's code; the pools are a fixture allowlist (real Ethereum / Monad addresses, plus adversarial entries) — tests never
// read the package's generated allowlist. The stub answers the router's get_dy from a per-pool rate, the pools' coins()
// and code, the router's code / version, the AddressProvider's id 2 and receipts.
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, type Hex} from "viem";
import {CURVE_DEPLOYMENTS, CURVE_ETH, type CurveDeployment} from "../src/deployments.js";
import type {CurveChainPools, CurvePool} from "../src/pools/types.js";

export const ME = "0x4444444444444444444444444444444444444444";
export const OTHER = "0x9999999999999999999999999999999999999999";
export const RPC = {1: ["https://rpc.test"], 42161: ["https://rpc.test"], 143: ["https://rpc.test"]};

export const ROUTER_CODE: Hex = "0x60016002600301";
export const POOL_CODE: Hex = "0x60046005600601";
const CODE_HASH = keccak256(ROUTER_CODE);
const POOL_HASH = keccak256(POOL_CODE);

export const DEPLOYMENTS: Readonly<Record<number, CurveDeployment>> = Object.fromEntries(
  Object.entries(CURVE_DEPLOYMENTS).map(([id, d]) => [id, {...d, codeHash: CODE_HASH}]),
);
export const D1 = DEPLOYMENTS[1]!;
export const D42161 = DEPLOYMENTS[42161]!;
export const D143 = DEPLOYMENTS[143]!;

// Ethereum tokens.
export const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
export const WETH = D1.weth;
export const STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
export const CRVUSD = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";
export const SCRVUSD = "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367";
export const MIM = "0x99D8a9C45b2ecA8864373A26D1459e3Dff1e17F3";
export const FAKE_USDT = "0x810ecC2aa8b798F28633e1586a718cd48083Bae9";
// Pools.
export const TRIPOOL = "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7";
export const CRVUSD_USDC = "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E";
export const STETH_NG = "0x21E27a5E5513D6e65C4f830167390997aA84843a";
export const TRICRYPTO_USDT = "0xf5f5B97624542D72A9E06f04804Bf81baA15e2B4";
export const MIM_META = "0x5a6A4D54456819380173272A5E8E9B9904BdF41B";
export const FAKE_USDT_POOL = "0xA6d9F4f3A67B35E81DFa560b0FcDE9B0751F1f53";
export const BROKEN_ALETH = "0xC4C319E2D4d66CcA4464C0c2B32c9Bd23ebe784e";
export const UNLISTED_POOL = "0x390f3595bCa2Df7d23783dFd126427CCeb997BF4";
// Monad.
export const M_AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
export const M_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
export const M_USDT0 = "0xe7cd86e13AC4309349F30B3435a9d337750fC82D";
export const M_3POOL = "0x942644106B073E30D72c2C5D7529D5C296ea91ab";
export const M_OLD_STABLE = "0x1111111111111111111111111111111111111111";
// The Liquity factory metapool: coins(i) answers 4096 bytes, the coin in the first word (fixtures/rpc, recorded live).
export const LUSD = "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0";
export const LUSD_META = "0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA";
export const LUSD_COINS = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/rpc/liquity-metapool-coins.json", import.meta.url)), "utf8")) as {pool: string; block: number; calls: {data: string; result: Hex}[]};

const pool = (p: Partial<CurvePool> & Pick<CurvePool, "address" | "name" | "coins" | "decimals" | "poolType">): CurvePool => ({swapTypes: [1], codeHash: POOL_HASH, tvlUsd: 1_000_000, ...p});

/** Not in {@link POOLS} (its routes would tie with the 3pool's); the stub answers for it, {@link WITH_LUSD} lists it. */
export const LUSD_POOL = pool({address: LUSD_META, name: "Curve.fi Factory USD Metapool: Liquity", coins: [LUSD, "0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490"], decimals: [18, 18], underlying: [LUSD, DAI, USDC, USDT], underlyingDecimals: [18, 18, 6, 6], basePool: TRIPOOL, poolType: 1, swapTypes: [1, 2], tvlUsd: 12_000_000});

export const POOLS: Readonly<Record<number, CurveChainPools>> = {
  1: {chainId: 1, builtAt: "2026-11-05T00:00:00Z", block: 1, pools: [
    pool({address: TRIPOOL, name: "3pool", coins: [DAI, USDC, USDT], decimals: [18, 6, 6], poolType: 1, tvlUsd: 160_000_000}),
    pool({address: CRVUSD_USDC, name: "crvUSD/USDC", coins: [USDC, CRVUSD], decimals: [6, 18], poolType: 1, tvlUsd: 13_000_000}),
    pool({address: STETH_NG, name: "stETH-ng", coins: [CURVE_ETH, STETH], decimals: [18, 18], poolType: 1, tvlUsd: 23_000_000}),
    pool({address: TRICRYPTO_USDT, name: "TricryptoUSDT", coins: [USDT, WBTC, WETH], decimals: [6, 8, 18], poolType: 30, tvlUsd: 13_000_000}),
    pool({address: MIM_META, name: "MIM/3CRV", coins: [MIM, "0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490"], decimals: [18, 18], underlying: [MIM, DAI, USDC, USDT], underlyingDecimals: [18, 18, 6, 6], basePool: TRIPOOL, poolType: 1, swapTypes: [1, 2], tvlUsd: 500_000}),
    // Adversarial: listed here, refused anyway (deny list).
    pool({address: FAKE_USDT_POOL, name: "fake USDT", coins: [FAKE_USDT, USDT], decimals: [18, 6], poolType: 10, tvlUsd: 9_000_000_000}),
    pool({address: BROKEN_ALETH, name: "alETH (drained 2023)", coins: [CURVE_ETH, "0x0100546F2cD4C9D97f798fFC9755E47865FF7Ee6"], decimals: [18, 18], poolType: 1, tvlUsd: 9_000_000_000}),
  ]},
  42161: {chainId: 42161, builtAt: "2026-11-05T00:00:00Z", block: 1, pools: [
    pool({address: "0x49b720F1Aab26260BEAec93A7BeB5BF2925b2A8F", name: "USDC/USDT0", coins: ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"], decimals: [6, 6], poolType: 10}),
  ]},
  143: {chainId: 143, builtAt: "2026-11-05T00:00:00Z", block: 1, pools: [
    pool({address: M_3POOL, name: "3pool", coins: [M_AUSD, M_USDC, M_USDT0], decimals: [6, 6, 6], poolType: 10}),
    // A legacy (pool_type 1) pool: a [4][5] router cannot drive it, so it never enters a route there.
    pool({address: M_OLD_STABLE, name: "legacy stable", coins: [M_USDC, M_AUSD], decimals: [6, 6], poolType: 1, tvlUsd: 9_000_000_000}),
  ]},
};

const ROUTER5 = parseAbi(["function get_dy(address[11] _route, uint256[5][5] _swap_params, uint256 _amount) view returns (uint256)"]);
const ROUTER4 = parseAbi(["function get_dy(address[11] _route, uint256[4][5] _swap_params, uint256 _amount) view returns (uint256)"]);
const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const uint = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const lc = (a: string) => a.toLowerCase();

export interface StubOptions {
  /** Output per pool hop in bps of the decimal-adjusted input (default 9_990: a 0.1% pool). */
  rateBps?: Record<string, number>;
  /** Price impact in bps on hops whose input is at least `impactFrom` (the probe 1/1000 below it sees none). */
  impactBps?: number;
  impactFrom?: bigint;
  /** Pools whose quote reverts. */
  revert?: string[];
  /** The router's code differs from the pin. */
  badRouterCode?: boolean;
  /** The router reports another version. */
  version?: string;
  /** The AddressProvider's id 2 answer (default: the pinned addressProviderRouter). */
  addressProvider?: string;
  /** A pool's code differs from its pin. */
  badPoolCode?: string[];
  /** coins(k) overrides: pool → index → address. */
  coins?: Record<string, Record<number, string>>;
  /** Receipt status ("0x1", "0x0" or null = not mined). */
  receipt?: string | null;
  /** HTTP-fail these URLs. */
  down?: string[];
  /** These URLs answer HTTP 200 with every element a -32007 rate-limit error (QuickNode under a burst). */
  limited?: string[];
  /** Raw coins(uint256) answers: pool → index → the return bytes (default: the Liquity metapool's recorded ones). */
  coinsRaw?: Record<string, Record<number, Hex>>;
  /** eth_getCode of these pools answers result null. */
  noCode?: string[];
}

/** Decimal-adjusted hop: amount × 10^dOut / 10^dIn × rate. */
function hop(amount: bigint, dIn: number, dOut: number, rateBps: number): bigint {
  return (amount * 10n ** BigInt(dOut) * BigInt(rateBps)) / (10n ** BigInt(dIn) * 10_000n);
}

export function rpcStub(o: StubOptions = {}): typeof fetch & {urls: string[]; batches: number[]; calls: {method: string; to?: string; data?: string}[]} {
  const urls: string[] = [];
  const batches: number[] = [];
  const seen: {method: string; to?: string; data?: string}[] = [];
  const byAddress = new Map<string, CurvePool>();
  for (const t of Object.values(POOLS)) for (const p of t.pools) byAddress.set(lc(p.address), p);
  byAddress.set(lc(LUSD_META), LUSD_POOL);
  const coinsRaw: Record<string, Record<number, Hex>> = {[lc(LUSD_META)]: Object.fromEntries(LUSD_COINS.calls.map((c) => [Number(BigInt(`0x${c.data.slice(10)}`)), c.result])), ...o.coinsRaw};
  const routers = new Map(Object.values(DEPLOYMENTS).map((d) => [lc(d.router), d]));
  const aps = new Map(Object.values(DEPLOYMENTS).map((d) => [lc(d.addressProvider), d]));
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (o.down?.includes(url)) return new Response("down", {status: 502});
    const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[];
    batches.push(batch.length);
    if (o.limited?.includes(url)) return new Response(JSON.stringify(batch.map((req) => ({id: req.id, error: {code: -32007, message: "50/second request limit reached - reduce calls per second or upgrade your account at quicknode.com"}}))));
    const out = batch.map((req) => {
      const fail = {id: req.id, error: {code: 3, message: "execution reverted"}};
      if (req.method === "eth_getTransactionReceipt") return {id: req.id, result: o.receipt === null || o.receipt === undefined ? null : {status: o.receipt}};
      if (req.method === "eth_getCode") {
        const at = lc(String(req.params[0]));
        seen.push({method: "eth_getCode", to: at});
        if (routers.has(at)) return {id: req.id, result: o.badRouterCode ? "0x6000" : ROUTER_CODE};
        if (o.noCode?.some((p) => lc(p) === at)) return {id: req.id, result: null};
        if (byAddress.has(at)) return {id: req.id, result: o.badPoolCode?.some((p) => lc(p) === at) ? "0x6000" : POOL_CODE};
        return {id: req.id, result: "0x"};
      }
      if (req.method !== "eth_call") return fail;
      const {to, data} = req.params[0] as {to: string; data: Hex};
      const at = lc(to);
      seen.push({method: "eth_call", to: at, data});
      const sel = data.slice(0, 10);
      if (sel === "0x54fd4d50") return {id: req.id, result: encodeAbiParameters([{type: "string"}], [o.version ?? routers.get(at)?.version ?? ""])};
      if (sel === "0x493f4f74" && aps.has(at)) {
        const d = [...routers.values()].find((x) => lc(x.addressProvider) === at)!;
        return {id: req.id, result: word(o.addressProvider ?? d.addressProviderRouter)};
      }
      if ((sel === "0xc6610657" || sel === "0x23746eb8") && byAddress.has(at)) {
        const k = Number(BigInt(`0x${data.slice(10)}`));
        const p = byAddress.get(at)!;
        if (sel === "0xc6610657" && coinsRaw[at]) return coinsRaw[at][k] ? {id: req.id, result: coinsRaw[at][k]} : fail;
        if (sel === "0x23746eb8" && lc(p.address) === lc(LUSD_META)) return fail; // the real pool has no coins(int128)
        const coin = o.coins?.[at]?.[k] ?? p.coins[k];
        return coin ? {id: req.id, result: word(coin)} : fail;
      }
      const d = routers.get(at);
      if (d && (sel === "0x81889a2c" || sel === "0x11e21386")) {
        const call = decodeFunctionData({abi: d.family === "ng5" ? ROUTER5 : ROUTER4, data});
        const [route, params, amountIn] = call.args as unknown as [readonly string[], readonly (readonly bigint[])[], bigint];
        let amount = amountIn;
        for (let k = 0; k < 5; k++) {
          const swap = lc(route[2 * k + 1]!);
          if (swap === lc("0x0000000000000000000000000000000000000000")) break;
          const t = params[k]![2]!;
          if (t === 8n) continue;
          if (t === 9n) { amount = params[k]![0] === 0n ? (amount * 9n) / 10n : (amount * 10n) / 9n; continue; }
          const p = byAddress.get(swap);
          if (!p || o.revert?.some((r) => lc(r) === swap)) return fail;
          const list = t === 2n ? p.underlying! : p.coins;
          const decs = t === 2n ? p.underlyingDecimals! : p.decimals;
          const i = Number(params[k]![0]), j = Number(params[k]![1]);
          if (lc(list[i]!) !== lc(route[2 * k]!) || lc(list[j]!) !== lc(route[2 * k + 2]!)) return fail;
          let next = hop(amount, decs[i]!, decs[j]!, o.rateBps?.[lc(p.address)] ?? 9_990);
          if (o.impactBps && amount >= (o.impactFrom ?? 1n)) next = (next * BigInt(10_000 - o.impactBps)) / 10_000n;
          amount = next;
        }
        return {id: req.id, result: uint(amount - 1n)};
      }
      return fail;
    });
    return new Response(JSON.stringify(out));
  }) as typeof fetch & {urls: string[]; batches: number[]; calls: typeof seen};
  f.urls = urls;
  f.batches = batches;
  f.calls = seen;
  return f;
}

export const TABLES = {deployments: DEPLOYMENTS, pools: POOLS};
/** {@link TABLES} with the Liquity metapool listed on Ethereum. */
export const WITH_LUSD = {deployments: DEPLOYMENTS, pools: {...POOLS, 1: {...POOLS[1]!, pools: [...POOLS[1]!.pools, LUSD_POOL]}}};
