// Liquid NEAR staking constants: the LiNEAR contract family (LiNEAR and its fork Rhea rNEAR).
// Contract ids, code hashes and views checked on mainnet / testnet on 2026-11-08 (ft_metadata,
// get_summary, get_account_details, is_paused, storage_balance_bounds, view_account.code_hash).
// Meta Pool stNEAR is deliberately not here: it is a different contract family, offered by apps as
// "Instant stNEAR via 1Click" only.

import type { NearNetwork } from './types.js'

export const NEAR_MAINNET = 'near:mainnet'
export const NEAR_TESTNET = 'near:testnet'

export const YOCTO_PER_NEAR = 10n ** 24n
export const TGAS = 10n ** 12n

/** LST decimals for the whole family (LINEAR, rNEAR). */
export const LST_DECIMALS = 24
/** `ft_price` scale: yoctoNEAR per 1 whole token (10^24 = 1 NEAR per token). */
export const PRICE_SCALE = 10n ** 24n

/** Epochs an unstake waits at least (the contract may add more: big amounts, after the epoch's settlement). */
export const MIN_EPOCHS_TO_UNLOCK = 4n
/** Block heights per epoch, mainnet and testnet. */
export const EPOCH_LENGTH = 43_200n
/** Fallback epoch duration when the chain cannot be read: ~6.9 h (measured 6.9–7.1 h on mainnet in November 2026). */
export const TYPICAL_EPOCH_MS = 24_840_000
/**
 * Unstaked balances at or below this many yoctoNEAR are treated as empty. `deposit_and_stake` charges
 * the share price rounded down and leaves the remainder (a yocto or two) unstaked; offering to
 * withdraw it would cost more gas than it is worth.
 */
export const UNSTAKED_DUST = 1_000_000n
/**
 * Liquid NEAR the contract keeps for itself: a withdrawal needs contract balance − 1 NEAR ≥ amount
 * (assert_can_withdraw). The runtime also keeps the contract's storage cost (storage_usage × 10^19:
 * ~52 NEAR for rNEAR, ~133 NEAR for LiNEAR), so what it can pay is balance − max(1 NEAR, storage).
 */
export const CONTRACT_MIN_RESERVE_BALANCE = YOCTO_PER_NEAR
/** NEP-145 registration, the same on every family contract (storage_balance_bounds.min). Only for receiving the token by transfer: `deposit_and_stake` registers the staker itself. */
export const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n

/**
 * NEAR left on the account by `stake`: 0.02 NEAR. `stake` never leaves less than the upfront gas of
 * one unstake (about 0.035 NEAR at today's prices, see fees.ts), so the stake can always be left.
 */
export const DEFAULT_RESERVE = 2n * 10n ** 22n
/** Smallest stake the module sends: 0.001 NEAR. */
export const MIN_STAKE = 10n ** 21n

/**
 * Prepaid gas per call. All of it is bought upfront at min_gas_purchase_price (the unburnt part is
 * refunded), so it is kept near what the calls use. Burnt on mainnet (whole transaction):
 * deposit_and_stake ~3.1–3.5 Tgas on both contracts (it stakes nothing itself: the operator bot does;
 * an rNEAR stake with 30 Tgas prepaid succeeded), unstake_all 3.5, withdraw_all 3.4 (rNEAR) to ~11
 * (LiNEAR). None of them makes a cross-contract call but the payout transfer.
 */
export const DEFAULT_GAS = {
  stake: 30n * TGAS,
  unstake: 30n * TGAS,
  withdraw: 30n * TGAS,
} as const

/** Gas price margin of fee estimates (+10 %, as wallet-near's own estimate), so a quoted fee also passes as `maxFee`. */
export const GAS_PRICE_MARGIN_NUM = 11n
export const GAS_PRICE_MARGIN_DEN = 10n
/**
 * Price per prepaid gas unit when the node cannot report `runtime_config.min_gas_purchase_price`:
 * the mainnet value (protocol 88, Nov 2026), so balance checks fail toward needing more.
 */
export const MIN_GAS_PURCHASE_PRICE_FALLBACK = 10n ** 9n

/** Epochs the APR looks back over by default (~7 days at ~6.9 h per epoch). */
export const DEFAULT_APR_WINDOW_EPOCHS = 24

/** Archival RPC for the APR's past price (regular nodes keep ~5 epochs). */
export const DEFAULT_ARCHIVAL_RPC: Record<NearNetwork, string> = {
  mainnet: 'https://archival-rpc.mainnet.fastnear.com',
  testnet: 'https://archival-rpc.testnet.fastnear.com',
}

/** A family contract the module knows: account id per network and the code hashes accepted for writes. */
export interface LiquidPreset {
  symbol: string
  name: string
  contracts: Partial<Record<NearNetwork, { contract: string; codeHashes: readonly string[] }>>
}

/** Built-in pools. Writes refuse a contract whose live code_hash is not pinned here (or in the app's config). */
export const LIQUID_PRESETS = {
  linear: {
    symbol: 'LINEAR',
    name: 'LiNEAR',
    contracts: {
      mainnet: { contract: 'linear-protocol.near', codeHashes: ['5LiDVDd1gh7ofVNbiA9VXrWwkv2m8tw46jZqYeuoC3SG'] },
      testnet: { contract: 'linear-protocol.testnet', codeHashes: ['8Bby4ofnYGtudd3PinKZ1KyvmUKJVyxmfC99ZccRDVDv'] },
    },
  },
  rnear: {
    symbol: 'rNEAR',
    name: 'Rhea Liquid Near Staking Token',
    contracts: {
      mainnet: { contract: 'lst.rhealab.near', codeHashes: ['EPLT4C61pkVYf5Km6dC4X9x5PMo6rfBwuEwo7vgKpmuv'] }, // v1.0.2
    },
  },
} as const satisfies Record<string, LiquidPreset>

/** Preset names. */
export type LiquidPresetName = keyof typeof LIQUID_PRESETS
