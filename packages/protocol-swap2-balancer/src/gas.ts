/**
 * `Quote.gasEstimate` for Balancer v2 (protocol-swap2-core's contract, source `"model"`): the gas the Vault `batchSwap`
 * is expected to use — not its limit (the quote's `gasLimit`, 160,000 + 95,000 a hop, is unchanged), and no approval.
 * The Vault's `queryBatchSwap` measures no gas, so the figure is a measured table: a base for the call (the intrinsic
 * 21,000, the calldata, the Vault's entry and its net settlement — the input pulled from the sender, the output paid to
 * the recipient, wrapping or unwrapping WETH for the native coin) plus one cost per hop by the pool's specialization,
 * which its pool id carries (bytes 20–21: 0 general, the Vault passing the pool every balance — composable stable
 * pools, for example; 1 minimal swap info — weighted pools of three or more tokens, for example; 2 two token).
 *
 * Fitted (least squares, Huber-weighted) on 2026-11-28 to the module's own quotes on Ethereum, Arbitrum, Base and OP
 * Mainnet — 29 pairs, routes of one to four hops — each simulated with `eth_simulateV1` from a
 * funded account (`[approve(Vault, exactly the input), batchSwap]`), to a recipient holding none of the output and to
 * one holding some (the table sits halfway: the recipient's balance slot written from zero is 17,100), and checked
 * against the two real `batchSwap` transactions sent straight to the Vault found on those chains (README "Gas
 * estimate"): median error 5%, 9 in 10 within 18%. The spread is each pool's own math within a specialization
 * (weighted or stable invariants, rate providers), which the pool id does not say.
 *
 * Only on the chains measured; left out, never guessed: Polygon and Gnosis (their quotes used up to 59% and 42% more
 * than the table says), Sonic (its `eth_simulateV1` reports no usable gas), Plasma (no route to measure), Avalanche (no endpoint
 * measured). A pool id whose specialization is none of the three gets no estimate either.
 */

/** The call's own gas: what any batch pays besides its hops. */
export const BALANCER_GAS_BASE = 80_000n;

/** Gas per hop by the pool's specialization (from its pool id). */
export const BALANCER_HOP_GAS: Readonly<Record<"general" | "minimal" | "two-token", bigint>> = Object.freeze({
  general: 95_500n,
  minimal: 40_500n,
  "two-token": 36_400n,
});

/** The chains the table was measured on (Ethereum's gas schedule). */
export const BALANCER_GAS_CHAINS: ReadonlySet<number> = new Set<number>([1, 10, 8453, 42161]);

/** A pool id's specialization (bytes 20–21), or undefined for a value the Vault does not define. */
export function balancerSpecialization(poolId: string): "general" | "minimal" | "two-token" | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) return undefined;
  const code = parseInt(poolId.slice(42, 46), 16);
  return code === 0 ? "general" : code === 1 ? "minimal" : code === 2 ? "two-token" : undefined;
}

/** At most 10 digits (protocol-swap2-core's canonical gas units). */
const MAX_UNITS = 9_999_999_999n;

/**
 * The batch's expected gas: the base plus each hop's cost. Undefined on a chain without a measured table, for a pool
 * id of no known specialization, and when it would exceed the quote's `gasLimit`.
 */
export function balancerGasEstimate(chainId: number, poolIds: readonly string[], gasLimit: bigint): bigint | undefined {
  if (!BALANCER_GAS_CHAINS.has(chainId) || poolIds.length === 0) return undefined;
  let gas = BALANCER_GAS_BASE;
  for (const id of poolIds) {
    const spec = balancerSpecialization(id);
    if (spec === undefined) return undefined;
    gas += BALANCER_HOP_GAS[spec];
  }
  return gas > 0n && gas <= gasLimit && gas <= MAX_UNITS ? gas : undefined;
}
