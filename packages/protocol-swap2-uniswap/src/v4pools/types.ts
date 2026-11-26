/** A 0x-prefixed hex string (address, PoolId): viem's `Hex`, so the two never clash. */
import type {Hex} from "viem";
export type {Hex};

/**
 * A Uniswap v4 PoolKey (`PoolKey.sol`): currency0 < currency1 numerically, the native coin is `0x0` (always
 * currency0), `fee` in pips (1e-6), `hooks` 0x0 for a hookless pool (the only kind this module routes through).
 */
export interface V4PoolKey {
  currency0: Hex;
  currency1: Hex;
  fee: number;
  tickSpacing: number;
  /** Absent = 0x0 (hookless). */
  hooks?: Hex;
}

/** One pinned hookless pool: its key and its PoolId (= keccak256(abi.encode(key)), recomputed by the build and at runtime). */
export interface V4ListedPool {
  currency0: Hex;
  currency1: Hex;
  fee: number;
  tickSpacing: number;
  /** PoolId, lower-case. */
  id: Hex;
}

/** The pinned pools of one chain, as built by scripts/build-v4-pools.mjs. */
export interface V4ChainPools {
  chainId: number;
  /** The PoolManager whose Initialize log the list was built from, and the StateView the gate read. */
  poolManager: Hex;
  stateView: Hex;
  /** ISO date of the build. */
  builtAt: string;
  /** Block the index ends at and the on-chain gate ran at. */
  block: number;
  /** Highest LP fee (pips) a listed pool may charge. */
  feeCap: number;
  /** The pair filter: every currency a listed pool may hold (catalog tokens, 0x0 for the native coin, the wrapped native). */
  tokens: readonly Hex[];
  pools: readonly V4ListedPool[];
}
