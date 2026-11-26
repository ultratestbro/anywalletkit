// Shared Monad constants and builders for the v4 tests. Addresses and pool ids from UNISWAP-V4-RESEARCH §2.3, §4
// (recorded 2026-11-25); the dummy actors are the research lanes' (0x1111… user, 0x2222… recipient / attacker).
import {readFileSync} from "node:fs";
import {concatHex, encodeAbiParameters, encodeFunctionData, getAddress, parseAbiParameters, type Hex} from "viem";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import {SWAP_PROXY_ABI, UNISWAP_V4, UR_ABI, V4_EXACT_IN_ABI, V4_EXACT_IN_SINGLE_ABI, V4_SETTLE_ABI, V4_SWAP_INPUT_ABI, V4_TAKE_ABI} from "../src/v4/addresses.js";
import {encodeV4Swap, v4PathOf, type V4SwapRequest} from "../src/v4/encode.js";
import type {V4PoolKey} from "../src/v4/pool.js";

export const MONAD = 143;
export const D143 = UNISWAP_V4[MONAD]!;
export const NATIVE = "0x0000000000000000000000000000000000000000" as const;
export const AUSD = getAddress("0x00000000efe302beaa2b3e6e1b18d08d69a9012a");
export const USDC = getAddress("0x754704bc059f8c67012fed69bc8a327a5aafb603");
export const USDT0 = getAddress("0xe7cd86e13ac4309349f30b3435a9d337750fc82d");
export const WMON = getAddress("0x3bd359c1119da7da1d913d1c4d2b7c461115433a");
export const USER = "0x1111111111111111111111111111111111111111" as const;
export const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
export const ATTACKER = "0x3333333333333333333333333333333333333333" as const;
/** Monad UR 2.0 and UR 2.1.1 (live, not pinned; §4.4 #4). */
export const UR20_143 = getAddress("0x0d97dc33264bfc1c226207428a79b26757fb9dc3");
export const UR211_143 = getAddress("0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7");
/** The Kyber KEM hook on Monad's hooked AUSD/USDC pool (refused by design, §6.1). */
export const KEM_HOOK = getAddress("0x4445520306c9c70952bdfec28f3989f53d9f80c4");

/** NATIVE/AUSD 500/1 — the E1 pool (`0xadaf3077…d8219`). */
export const MON_AUSD_500_1: V4PoolKey = {currency0: NATIVE, currency1: AUSD, fee: 500, tickSpacing: 1, hooks: NATIVE};
/** NATIVE/USDC 500/10 (`0x18a9fc87…9954`), the deep MON leg. */
export const MON_USDC_500_10: V4PoolKey = {currency0: NATIVE, currency1: USDC, fee: 500, tickSpacing: 10, hooks: NATIVE};
/** AUSD/USDC 50/1 (`0x092b6504…ce72`), the decisive non-standard tier. */
export const AUSD_USDC_50_1: V4PoolKey = {currency0: AUSD, currency1: USDC, fee: 50, tickSpacing: 1, hooks: NATIVE};
/** NATIVE/AUSD 10000/200 (`0x68be0d1f…fdb3`), the thin partial-fill pool. */
export const MON_AUSD_10000_200: V4PoolKey = {currency0: NATIVE, currency1: AUSD, fee: 10_000, tickSpacing: 200, hooks: NATIVE};
/** WMON/AUSD 500/1 (uninitialised on chain; here only as "the wrapped token in place of native"). */
export const WMON_AUSD_500_1: V4PoolKey = {currency0: AUSD, currency1: WMON, fee: 500, tickSpacing: 1, hooks: NATIVE};
/** NATIVE/USDT0 and USDT0/AUSD, for a three-hop vector. */
export const MON_USDT0_500_10: V4PoolKey = {currency0: NATIVE, currency1: USDT0, fee: 500, tickSpacing: 10, hooks: NATIVE};

/** The shipped list the verifier is given in these tests. */
export const POOLS = {[MONAD]: [MON_AUSD_500_1, MON_USDC_500_10, AUSD_USDC_50_1, MON_AUSD_10000_200, MON_USDT0_500_10]} as const;

/** E1 (§3.10): 100 MON → AUSD on NATIVE/AUSD 500/1, quote 1,095,474, min 1,089,996, deadline 0x6b075540. */
export const E1_DEADLINE = 0x6b075540n;
export const NOW_MS = Number(E1_DEADLINE - 300n) * 1000;
export const now = () => NOW_MS;

export interface Case {
  params: QuoteParams;
  quote: Quote;
  req: V4SwapRequest;
}

/** A request + quote built by this module's own encoder (the honest server). */
export function makeCase(o: Partial<V4SwapRequest> & {sourceToken?: string; destToken?: string; destAmount?: bigint} = {}): Case {
  const req: V4SwapRequest = {
    chainId: MONAD,
    currencyIn: NATIVE,
    currencyOut: AUSD,
    pools: [MON_AUSD_500_1],
    amountIn: 100n * 10n ** 18n,
    amountOutMinimum: 1_089_996n,
    recipient: RECIPIENT,
    deadline: E1_DEADLINE,
    ...o,
  };
  const enc = encodeV4Swap(req);
  const caip2 = `eip155:${req.chainId}`;
  const sourceToken = o.sourceToken ?? (req.currencyIn === NATIVE ? ccAssetByToken(caip2, "")!.symbol : ccAssetByToken(caip2, req.currencyIn)?.symbol ?? req.currencyIn);
  const destToken = o.destToken ?? req.currencyOut;
  const params: QuoteParams = {sourceChain: caip2, destChain: caip2, sourceToken, destToken, amountIn: req.amountIn.toString(), destAddress: req.recipient};
  const quote: Quote = {
    provider: "uniswap",
    intentId: `uniswap:${req.chainId}`,
    depositAddress: "",
    depositMemo: null,
    txRequest: {to: enc.to, data: enc.data, value: enc.value.toString(), chainId: req.chainId, ...(enc.approvalAddress ? {approvalAddress: enc.approvalAddress} : {})},
    sourceAmount: req.amountIn.toString(),
    destAmount: (o.destAmount ?? req.amountOutMinimum + 5_478n).toString(),
    minDestAmount: req.amountOutMinimum.toString(),
    feeUsd: 0,
    etaSeconds: 15,
    reliability: 0.98,
    validUntilMs: NOW_MS + 300_000,
  };
  return {params, quote, req};
}

/** The same quote with another call (and optionally other tx fields). */
export function withTx(c: Case, tx: Partial<NonNullable<Quote["txRequest"]>>): Quote {
  return {...c.quote, txRequest: {...c.quote.txRequest!, ...tx}};
}

// ── Raw builders for hostile vectors ─────────────────────────────────────────────────────────────────────────────
const b = (x: number): Hex => `0x${x.toString(16).padStart(2, "0")}`;
export const actionsHex = (xs: readonly number[]): Hex => concatHex(xs.map(b));
export const single = (p: {poolKey?: V4PoolKey; zeroForOne?: boolean; amountIn?: bigint; amountOutMinimum?: bigint; minHopPriceX36?: bigint; hookData?: Hex} = {}): Hex =>
  encodeAbiParameters(V4_EXACT_IN_SINGLE_ABI, [{poolKey: p.poolKey ?? MON_AUSD_500_1, zeroForOne: p.zeroForOne ?? true, amountIn: p.amountIn ?? 100n * 10n ** 18n, amountOutMinimum: p.amountOutMinimum ?? 1_089_996n, minHopPriceX36: p.minHopPriceX36 ?? 0n, hookData: p.hookData ?? "0x"}]);
export const pathSwap = (p: {currencyIn?: `0x${string}`; pools?: readonly V4PoolKey[]; path?: {intermediateCurrency: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}`; hookData: Hex}[]; minHopPriceX36?: readonly bigint[]; amountIn?: bigint; amountOutMinimum?: bigint} = {}): Hex => {
  const currencyIn = p.currencyIn ?? NATIVE;
  const path = p.path ?? v4PathOf(currencyIn, p.pools ?? [MON_USDC_500_10, AUSD_USDC_50_1]);
  return encodeAbiParameters(V4_EXACT_IN_ABI, [{currencyIn, path, minHopPriceX36: p.minHopPriceX36 ?? [], amountIn: p.amountIn ?? 100n * 10n ** 18n, amountOutMinimum: p.amountOutMinimum ?? 1_089_996n}]);
};
export const settle = (currency: `0x${string}` = NATIVE, amount: bigint = 100n * 10n ** 18n, payerIsUser = false): Hex => encodeAbiParameters(V4_SETTLE_ABI, [currency, amount, payerIsUser]);
export const take = (currency: `0x${string}` = AUSD, recipient: `0x${string}` = RECIPIENT, amount = 0n): Hex => encodeAbiParameters(V4_TAKE_ABI, [currency, recipient, amount]);
export const v4Input = (actions: readonly number[], params: readonly Hex[]): Hex => encodeAbiParameters(V4_SWAP_INPUT_ABI, [actionsHex(actions), params]);
/** The honest native-in V4 input (E1: 100 MON → AUSD), with parts replaced for a hostile vector. */
export const nativeInputOf = (o: {take?: Hex; settle?: Hex; swap?: Hex; actions?: number[]} = {}): Hex =>
  v4Input(o.actions ?? [0x06, 0x0b, 0x0e], [o.swap ?? single(), o.settle ?? settle(), o.take ?? take()]);
export const urExecute = (commands: Hex, inputs: readonly Hex[], deadline: bigint = E1_DEADLINE): Hex => encodeFunctionData({abi: UR_ABI, functionName: "execute", args: [commands, inputs, deadline]});
export const proxyExecute = (router: `0x${string}`, token: `0x${string}`, amount: bigint, commands: Hex, inputs: readonly Hex[], deadline: bigint = E1_DEADLINE): Hex =>
  encodeFunctionData({abi: SWAP_PROXY_ABI, functionName: "execute", args: [router, token, amount, commands, inputs, deadline]});

/** UR 2.0 layouts (no `minHopPriceX36`), for the layout-confusion vectors only — this module never writes them. */
export const UR20_EXACT_IN_SINGLE_ABI = parseAbiParameters(
  "((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)",
);
export const UR20_EXACT_IN_ABI = parseAbiParameters(
  "(address currencyIn, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint128 amountIn, uint128 amountOutMinimum)",
);

/** A recorded fixture under fixtures/v4/. */
export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/v4/${name}`, import.meta.url), "utf8")) as T;
}
export interface E1Fixture {
  pool: V4PoolKey; poolId: Hex; amountIn: string; minOut: string; deadline: Hex; recipient: `0x${string}`; quote: {amountOut: string; gasEstimate: string};
  calldata_2_1_x: Hex; bytes_2_1_x: number; calldata_2_0: Hex;
}
export const e1 = fixture<E1Fixture>("monad-e1.json");
