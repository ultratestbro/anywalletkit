// The dead-deposit rule Morpho's own SDK applies before a supply or deposit
// (github.com/morpho-org/sdks at tag @morpho-org/morpho-sdk-v9.2.0:
// packages/morpho-sdk/src/helpers/constant.ts for MIN_DEAD_SHARES and
// MIN_VAULT_V2_DEAD_ASSETS, packages/morpho-sdk/src/helpers/deadShares.ts for
// validateBlueMarketDeadShares / validateVaultV1DeadShares /
// validateVaultV2DeadShares). A market or vault nobody seeded with shares
// burned to 0x…dEaD can have its share price inflated while it is nearly
// empty, so the next depositor's assets round down to nothing. Only the
// target itself is checked here: the reference also walks the markets a vault
// can allocate to (V1 withdraw queue, V2 capped allocations), which this
// module does not. Withdrawals are never gated by it.
import { getAddress } from 'viem'

/** Where dead deposits are minted to; nobody can ever withdraw them. */
export const DEAD_ADDRESS = getAddress('0x000000000000000000000000000000000000dEaD')
/** Shares a Blue market, Vault V1 or Vault V2 must hold at `DEAD_ADDRESS` (1e9). */
export const MIN_DEAD_SHARES = 1_000_000_000n
/** Assets, in the vault asset's base units, a Vault V2's dead shares must be worth (1e6). */
export const MIN_VAULT_V2_DEAD_ASSETS = 1_000_000n

export interface DeadDeposit {
  /** Blue supply shares (market) or vault shares (vault) held at `DEAD_ADDRESS`. */
  deadShares: bigint
  /** What the dead shares are worth (`convertToAssets`); Vault V2 only, null otherwise. */
  deadAssets: bigint | null
  ok: boolean
  /**
   * The first condition that failed, null when `ok`. For `sharePrice` (Vault V2), `observed` is
   * `(_totalAssets + 1) × 10 × virtualShares` and `required` is `totalSupply + virtualShares + 1`.
   */
  failure: { reason: 'deadShares' | 'deadAssets' | 'sharePrice'; observed: bigint; required: bigint } | null
}

/** Vault V2 state the rule needs beyond the dead shares. */
export interface VaultV2DeadState { deadAssets: bigint; totalAssets: bigint; totalSupply: bigint; virtualShares: bigint }

/** Applies the rule to state already read; the checks run in the order the reference applies them. */
export function evaluateDeadDeposit(deadShares: bigint, v2?: VaultV2DeadState): DeadDeposit {
  const deadAssets = v2 ? v2.deadAssets : null
  const fail = (reason: 'deadShares' | 'deadAssets' | 'sharePrice', observed: bigint, required: bigint): DeadDeposit =>
    ({ deadShares, deadAssets, ok: false, failure: { reason, observed, required } })
  if (deadShares < MIN_DEAD_SHARES) return fail('deadShares', deadShares, MIN_DEAD_SHARES)
  if (v2) {
    if (v2.deadAssets < MIN_VAULT_V2_DEAD_ASSETS) return fail('deadAssets', v2.deadAssets, MIN_VAULT_V2_DEAD_ASSETS)
    // Share price (totalAssets + 1) / (totalSupply + virtualShares) must exceed 1 / (10 × virtualShares).
    const numerator = (v2.totalAssets + 1n) * 10n * v2.virtualShares
    const denominator = v2.totalSupply + v2.virtualShares
    if (numerator <= denominator) return fail('sharePrice', numerator, denominator + 1n)
  }
  return { deadShares, deadAssets, ok: true, failure: null }
}
