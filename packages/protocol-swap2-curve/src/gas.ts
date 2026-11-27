/**
 * `Quote.gasEstimate` for Curve (protocol-swap2-core's contract, source `"model"`): the gas a Router NG `exchange` is
 * expected to use — not a limit (the quote carries none: the wallet estimates the exact call before broadcast), and no
 * approval. `get_dy` measures no gas, so the figure is this table: a base for the call (the intrinsic 21,000, the
 * calldata, the router, the input's `transferFrom` and the payout) plus one cost per step by kind — a pool by its
 * router `pool_type`, its coin count and whether it swaps underlying coins, the native ↔ wrapped-native hop, the
 * ERC-4626 hop.
 *
 * Fitted (least squares, Huber-weighted) on 2026-11-28 to 763 real `exchange` transactions sent straight to the pinned
 * routers on Ethereum, Arbitrum, Base, OP Mainnet and Plasma along routes this module builds (`checkRoute` passes),
 * read from their receipts, and to the module's own quotes simulated with `eth_simulateV1` (README "Gas estimate"):
 * median error 4% on Ethereum's receipts, 9 in 10 within 12%. Real variance is the pool's coins (stETH or USDT0 cost
 * more to move than USDC) and whether the recipient held the output token before.
 *
 * Only on the chains measured, and only for routes whose every step has a measured cost: a route through a stable-ng
 * pool of three coins swapped directly (`t10/3`, one pool per chain, no transaction measured) gets no estimate, nor does
 * any route on Monad (another gas schedule, and its receipts report the gas limit, not the gas used), on X Layer (its
 * two simulated quotes ran 6–27% above the table), on Gnosis (no transaction and no quote to measure), or on a chain
 * not listed.
 */
import type {RouterArgs} from "./abi.js";
import type {CurvePool} from "./pools/types.js";
import type {CurveStep} from "./routes.js";

/** The call's own gas: what any route pays besides its steps. */
export const CURVE_GAS_BASE = 92_500n;

/**
 * Gas per step: `t<pool_type>/<coins>` (`u` when the step swaps a metapool's underlying coins — the count is then the
 * underlying coins), `wrap` (swap_type 8) and `4626` (swap_type 9, scrvUSD). Pool types: 1 stable, 2 twocrypto, 3
 * tricrypto, 10 stable-ng, 20 twocrypto-ng, 30 tricrypto-ng.
 */
export const CURVE_STEP_GAS: Readonly<Record<string, bigint>> = Object.freeze({
  "t1/2": 94_600n,
  "t1/3": 104_700n,
  "t1/4": 99_600n,
  "t1/4u": 239_000n,
  "t2/2": 225_500n,
  "t3/3": 252_600n,
  "t10/2": 128_300n,
  "t10/3u": 182_000n,
  "t20/2": 178_500n,
  "t30/3": 143_000n,
  wrap: 19_200n,
  "4626": 50_300n,
});

/** The chains the table was measured on (Ethereum's gas schedule). */
export const CURVE_GAS_CHAINS: ReadonlySet<number> = new Set([1, 10, 8453, 9745, 42161]);

/** A step's key in {@link CURVE_STEP_GAS}. */
export function curveStepKind(step: CurveStep): string {
  if (step.kind === "wrap") return "wrap";
  if (step.kind === "erc4626") return "4626";
  const under = step.swapType === 2;
  return `t${step.pool.poolType}/${(under ? step.pool.underlying ?? [] : step.pool.coins).length}${under ? "u" : ""}`;
}

/** The expected gas of a route given as its steps' kinds, or undefined when the chain or a kind has no measured cost. */
function estimateOfKinds(chainId: number, kinds: readonly string[]): bigint | undefined {
  if (!CURVE_GAS_CHAINS.has(chainId) || kinds.length === 0) return undefined;
  let gas = CURVE_GAS_BASE;
  for (const kind of kinds) {
    const cost = Object.prototype.hasOwnProperty.call(CURVE_STEP_GAS, kind) ? CURVE_STEP_GAS[kind] : undefined;
    if (cost === undefined) return undefined;
    gas += cost;
  }
  return gas;
}

/** The route's expected gas, or undefined when the chain or one of its steps has no measured cost. */
export function curveGasEstimate(chainId: number, steps: readonly CurveStep[]): bigint | undefined {
  return estimateOfKinds(chainId, steps.map(curveStepKind));
}

/**
 * The same figure for router arguments read back from a call (a remote quote, a mined transaction): each step's kind
 * from its swap_type and, for a pool, the allowlist's entry for it (`pools`, by lower-case address — `poolIndex`).
 * Undefined when a pool is not in `pools`, a swap type is not one the module builds, or a kind has no measured cost.
 */
export function curveGasEstimateOfCall(chainId: number, args: RouterArgs, pools: ReadonlyMap<string, CurvePool>): bigint | undefined {
  const kinds: string[] = [];
  for (let k = 0; k < 5; k++) {
    const swap = args.route[2 * k + 1];
    if (!swap || /^0x0{40}$/i.test(swap)) break;
    const swapType = args.params[k]?.[2];
    if (swapType === 8n) kinds.push("wrap");
    else if (swapType === 9n) kinds.push("4626");
    else if (swapType === 1n || swapType === 2n) {
      const pool = pools.get(swap.toLowerCase());
      if (!pool) return undefined;
      const under = swapType === 2n;
      kinds.push(`t${pool.poolType}/${(under ? pool.underlying ?? [] : pool.coins).length}${under ? "u" : ""}`);
    } else return undefined;
  }
  return estimateOfKinds(chainId, kinds);
}
