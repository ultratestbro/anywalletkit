import type {V4ChainPools} from "./types.js";

/**
 * One chain's pinned pool list frozen in place, all the way down (review SEC-U4-R3-2): every pool row, the `pools` and
 * `tokens` arrays, then the list itself — so no code in the process can add, drop or rewrite a pinned pool after load.
 * Written by hand; the generated index (scripts/build-v4-pools.mjs `renderIndex`) wraps every chain's list in it.
 */
export function freezeChainPools(list: V4ChainPools): V4ChainPools {
  for (const pool of list.pools) Object.freeze(pool);
  Object.freeze(list.pools);
  Object.freeze(list.tokens);
  return Object.freeze(list);
}
