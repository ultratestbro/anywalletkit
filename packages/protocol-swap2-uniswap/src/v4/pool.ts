import {encodeAbiParameters, getAddress, keccak256, parseAbiParameters, type Hex} from "viem";
import {V4_NATIVE} from "./addresses.js";

/**
 * A Uniswap v4 pool key (`PoolKey.sol:11-22`). `currency0 < currency1` strictly by numeric address (the native coin,
 * `address(0)`, is always `currency0`); `fee` in pips (1e-6), or the dynamic-fee flag; `1 ≤ tickSpacing ≤ 32767`.
 * The native and the wrapped-native pools of a pair are different pools.
 */
export interface V4PoolKey {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

/** `LPFeeLibrary`: the largest static LP fee (100%), the dynamic-fee flag, and the hook's per-swap override flag. */
export const V4_MAX_LP_FEE = 1_000_000;
export const V4_DYNAMIC_FEE_FLAG = 0x800000;
export const V4_OVERRIDE_FEE_FLAG = 0x400000;
/** `TickMath.MIN_TICK_SPACING` / `MAX_TICK_SPACING`. */
export const V4_MIN_TICK_SPACING = 1;
export const V4_MAX_TICK_SPACING = 32_767;
/** `TickMath` price bounds; the V4Router passes MIN + 1 / MAX − 1 as its own limits. */
export const V4_MIN_SQRT_PRICE = 4295128739n;
export const V4_MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
/** Default fee cap for a pool this module routes through: 10% (owner decision 5). Live hookless pools charge 12%, 88%
 *  and 99.1% static fees, and most hookless pools on Arbitrum and Monad charge more than 10%. */
export const V4_DEFAULT_MAX_FEE_PIPS = 100_000;

/**
 * Hook permission bits: the low 14 bits of the hook's address (`Hooks.sol:26-46`). The swap-relevant ones are
 * `BEFORE_SWAP` / `AFTER_SWAP` (can sandwich, revert, or price the quoter and the router differently) and the two
 * swap return-delta bits (can take the specified or the unspecified currency without crediting the swapper).
 */
export const V4_HOOK_FLAGS = Object.freeze({
  BEFORE_INITIALIZE: 1 << 13,
  AFTER_INITIALIZE: 1 << 12,
  BEFORE_ADD_LIQUIDITY: 1 << 11,
  AFTER_ADD_LIQUIDITY: 1 << 10,
  BEFORE_REMOVE_LIQUIDITY: 1 << 9,
  AFTER_REMOVE_LIQUIDITY: 1 << 8,
  BEFORE_SWAP: 1 << 7,
  AFTER_SWAP: 1 << 6,
  BEFORE_DONATE: 1 << 5,
  AFTER_DONATE: 1 << 4,
  BEFORE_SWAP_RETURNS_DELTA: 1 << 3,
  AFTER_SWAP_RETURNS_DELTA: 1 << 2,
  AFTER_ADD_LIQUIDITY_RETURNS_DELTA: 1 << 1,
  AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: 1 << 0,
} as const);
/** Every hook permission bit. */
export const V4_ALL_HOOK_FLAGS = (1 << 14) - 1;
/** The bits that let a hook act on a swap. */
export const V4_SWAP_HOOK_FLAGS = V4_HOOK_FLAGS.BEFORE_SWAP | V4_HOOK_FLAGS.AFTER_SWAP | V4_HOOK_FLAGS.BEFORE_SWAP_RETURNS_DELTA | V4_HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA;

const POOL_KEY_ABI = parseAbiParameters("address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks");
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `PoolId = keccak256(abi.encode(key))` over the five 32-byte words (`PoolId.sol:11-16`). Throws for a key that cannot
 *  be ABI-encoded (an address that is not 20 bytes, a fee outside uint24, a tick spacing outside int24). */
export function poolIdOf(key: V4PoolKey): Hex {
  return keccak256(encodeAbiParameters(POOL_KEY_ABI, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}

/** The permission bits a hook address carries (0 for the hookless `address(0)`). */
export function hookFlagsOf(hooks: string): number {
  if (!ADDRESS.test(hooks)) throw new Error(`not an address: ${hooks}`);
  return Number.parseInt(hooks.slice(-4), 16) & V4_ALL_HOOK_FLAGS;
}

/** True for the hookless `address(0)`. */
export function isHookless(hooks: string): boolean {
  return ADDRESS.test(hooks) && /^0x0{40}$/.test(hooks);
}

/** True when the hook address can act on a swap (any swap or swap return-delta bit). */
export function hasSwapHooks(hooks: string): boolean {
  return (hookFlagsOf(hooks) & V4_SWAP_HOOK_FLAGS) !== 0;
}

/** True for a dynamic-fee key (`LPFeeLibrary.isDynamicFee`: the fee is exactly the flag; a hookless key cannot be
 *  dynamic — the PoolManager refuses to initialise one, and quoting it reverts `PoolNotInitialized`). */
export function isDynamicFee(fee: number): boolean {
  return fee === V4_DYNAMIC_FEE_FLAG;
}

/** True for a fee a static (non-dynamic) pool can charge: an integer in [0, 1,000,000] pips. */
export function isValidStaticFee(fee: number): boolean {
  return Number.isInteger(fee) && fee >= 0 && fee <= V4_MAX_LP_FEE;
}

/** The two currencies in PoolKey order (numeric address order; `address(0)` first). Throws on equal currencies. */
export function sortCurrencies(a: string, b: string): [`0x${string}`, `0x${string}`] {
  const x = getAddress(a);
  const y = getAddress(b);
  if (x === y) throw new Error("a pool needs two different currencies");
  return BigInt(x) < BigInt(y) ? [x, y] : [y, x];
}

/** The pool's other currency, or null when `currency` is not in it. */
export function otherCurrency(key: V4PoolKey, currency: string): `0x${string}` | null {
  const c = getAddress(currency);
  if (getAddress(key.currency0) === c) return getAddress(key.currency1);
  if (getAddress(key.currency1) === c) return getAddress(key.currency0);
  return null;
}

/**
 * Why a key is not a pool this module routes through, or null: currencies not 20-byte addresses or not strictly
 * ordered, a hook (hookless only in v1, empty allowlist — owner decision 4), a dynamic fee, a fee above `maxFeePips`
 * (default 10%), or a tick spacing outside [1, 32767].
 */
export function v4PoolKeyProblem(key: V4PoolKey, maxFeePips: number = V4_DEFAULT_MAX_FEE_PIPS): string | null {
  if (!key || typeof key !== "object") return "not a pool key";
  if (![key.currency0, key.currency1, key.hooks].every((a) => typeof a === "string" && ADDRESS.test(a))) return "the pool key does not name 20-byte addresses";
  if (!(BigInt(key.currency0) < BigInt(key.currency1))) return "the pool key's currencies are not in order (currency0 < currency1)";
  if (!isHookless(key.hooks)) return `the pool has a hook (${getAddress(key.hooks)}): hookless pools only`;
  if (!Number.isInteger(key.fee) || isDynamicFee(key.fee)) return "the pool's fee is dynamic: hookless pools have a static fee";
  if (!isValidStaticFee(key.fee)) return `the pool's fee ${key.fee} is not a valid static fee`;
  if (key.fee > maxFeePips) return `the pool's fee ${key.fee / 10_000}% is above the ${maxFeePips / 10_000}% cap`;
  if (!Number.isInteger(key.tickSpacing) || key.tickSpacing < V4_MIN_TICK_SPACING || key.tickSpacing > V4_MAX_TICK_SPACING) return `the pool's tick spacing ${key.tickSpacing} is outside [1, 32767]`;
  return null;
}

/** A key with checksummed addresses (for comparisons and stable output). */
export function normalizeV4PoolKey(key: V4PoolKey): V4PoolKey {
  return {currency0: getAddress(key.currency0), currency1: getAddress(key.currency1), fee: key.fee, tickSpacing: key.tickSpacing, hooks: getAddress(key.hooks)};
}

/** True for the native coin as a v4 currency. */
export function isNativeCurrency(currency: string): boolean {
  return typeof currency === "string" && currency.toLowerCase() === V4_NATIVE;
}
