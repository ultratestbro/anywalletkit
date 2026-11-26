import {encodeAbiParameters, getAddress, keccak256, type Hex} from "viem";
import type {V4PoolKey} from "../v4pools/types.js";

/** The native coin as a v4 currency (always `currency0` of its pools). Native and wrapped-native pools are different pools. */
export const V4_NATIVE: Hex = "0x0000000000000000000000000000000000000000";
/** Owner decision 5: no pool charging more than 10% (100000 pips) is ever a candidate. `LPFeeLibrary.MAX_LP_FEE` is 100%. */
export const V4_MAX_FEE_PIPS = 100_000;
/** TickMath bounds (`TickMath.sol`). */
export const V4_MIN_TICK = -887272;
export const V4_MAX_TICK = 887272;
const DYNAMIC_FEE_FLAG = 0x800000;

const POOL_KEY_ABI = [{type: "address"}, {type: "address"}, {type: "uint24"}, {type: "int24"}, {type: "address"}] as const;

/** A PoolKey with every field checked and the addresses checksummed (`hooks` = 0x0 unless given). */
export interface V4Key {
  currency0: Hex;
  currency1: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Hex;
}

/** `PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))` (`PoolId.sol`), lower-case. */
export function poolIdOf(key: V4PoolKey): Hex {
  return keccak256(encodeAbiParameters(POOL_KEY_ABI, [getAddress(key.currency0), getAddress(key.currency1), key.fee, key.tickSpacing, getAddress(key.hooks ?? V4_NATIVE)])).toLowerCase() as Hex;
}

/** The two currencies in PoolKey order (numeric address order: native 0x0 first). */
export function sortCurrencies(a: Hex, b: Hex): [Hex, Hex] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/** A canonical key for an unordered pair of currencies. */
export const pairKeyOf = (a: Hex, b: Hex): string => sortCurrencies(a, b).map((x) => x.toLowerCase()).join(":");

/**
 * Checks a PoolKey against the protocol's rules and this module's policy, or throws: currency0 < currency1, 1 ≤
 * tickSpacing ≤ 32767, a static LP fee (a hookless key cannot be dynamic) no higher than `maxFeePips`, and no hook
 * (decision 4: hookless only, the allowlist is empty).
 */
export function checkedHooklessKey(key: V4PoolKey, maxFeePips: number = V4_MAX_FEE_PIPS): V4Key {
  let c0: Hex, c1: Hex, hooks: Hex;
  try {
    c0 = getAddress(key.currency0);
    c1 = getAddress(key.currency1);
    hooks = getAddress(key.hooks ?? V4_NATIVE);
  } catch {
    throw new Error("uniswap v4: a pool key names something that is not an address");
  }
  if (!(BigInt(c0) < BigInt(c1))) throw new Error(`uniswap v4: pool key currencies are not in order (${c0} ≥ ${c1})`);
  if (!Number.isInteger(key.tickSpacing) || key.tickSpacing < 1 || key.tickSpacing > 32767) throw new Error(`uniswap v4: tickSpacing ${key.tickSpacing} is outside 1..32767`);
  if (!Number.isInteger(key.fee) || key.fee < 0 || (key.fee & DYNAMIC_FEE_FLAG) !== 0 || key.fee > 1_000_000) throw new Error(`uniswap v4: fee ${key.fee} is not a static LP fee`);
  if (key.fee > maxFeePips) throw new Error(`uniswap v4: fee ${key.fee} pips is above the ${maxFeePips}-pip cap`);
  if (hooks !== getAddress(V4_NATIVE)) throw new Error(`uniswap v4: pool ${c0}/${c1} ${key.fee}/${key.tickSpacing} has hook ${hooks} — only hookless pools are routed`);
  return {currency0: c0, currency1: c1, fee: key.fee, tickSpacing: key.tickSpacing, hooks};
}

/** Validates a `maxFeePips` setting: an integer in 1..{@link V4_MAX_FEE_PIPS} (the cap may be lowered, never raised). */
export function checkedMaxFeePips(value: number | undefined): number {
  const v = value ?? V4_MAX_FEE_PIPS;
  if (!Number.isInteger(v) || v < 1 || v > V4_MAX_FEE_PIPS) throw new Error(`uniswap v4: v4MaxFeePips must be an integer in 1..${V4_MAX_FEE_PIPS}`);
  return v;
}
