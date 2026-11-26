import {UNISWAP_V4_POOLS} from "../v4pools/index.js";
import {V4_NATIVE} from "./addresses.js";
import type {V4PoolKey} from "./pool.js";

/**
 * The shipped per-chain pool lists (`src/v4pools`, scripts/build-v4-pools.mjs) as PoolKeys — every listed pool is
 * hookless, so `hooks` is `address(0)`. This is the provenance a v4 quote's pools are checked against
 * (UNISWAP-V4-RESEARCH §6.5 row 9): a pool must be in it or in the integrator's own `v4ExtraPools`, never a key a server
 * named alone. One frozen array per chain (the verifier caches the PoolIds per array).
 */
export const UNISWAP_V4_POOL_KEYS: Readonly<Record<number, readonly V4PoolKey[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(UNISWAP_V4_POOLS).map(([id, list]) => [
      Number(id),
      Object.freeze(list.pools.map((p) => Object.freeze({currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: V4_NATIVE}))),
    ]),
  ),
);
