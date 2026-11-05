// TEMPORARY stand-in for the generated allowlist index (replaced by the allowlist generator's output at merge).
import type {CurveChainPools} from "./types.js";
import {POOLS_1} from "./1.js";
import {POOLS_42161} from "./42161.js";
import {POOLS_143} from "./143.js";

export type {CurveChainPools, CurvePool, Hex} from "./types.js";

/** The curated pool allowlist per chain id: the only pools a Curve route may cross. */
export const CURVE_POOLS: Readonly<Record<number, CurveChainPools>> = Object.freeze({
  1: POOLS_1,
  42161: POOLS_42161,
  143: POOLS_143,
});
