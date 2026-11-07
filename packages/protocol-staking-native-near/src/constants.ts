// NEAR native staking constants. Values checked with view calls on mainnet and testnet, 2026-11-08
// (validators RPC, view_account code hashes, protocol config). Contract behaviour from the
// core-contracts staking pool source (NUM_EPOCHS_TO_UNLOCK, unstake resets the timer).

import type { NearNetwork } from './types.js'

/** CAIP-2 ids. */
export const NEAR_MAINNET = 'near:mainnet'
export const NEAR_TESTNET = 'near:testnet'
export const NEAR_CHAINS = [NEAR_MAINNET, NEAR_TESTNET] as const

/** 1 NEAR in yoctoNEAR. */
export const YOCTO_PER_NEAR = 10n ** 24n
/** 1 Tgas. */
export const TGAS = 10n ** 12n

/**
 * Epochs between an `unstake` and the balance becoming withdrawable. Every new `unstake` (or
 * `unstake_all`) restarts this timer for the account's WHOLE unstaked balance in that pool.
 */
export const NUM_EPOCHS_TO_UNLOCK = 4n
/** Epoch length in block heights (mainnet and testnet). */
export const EPOCH_LENGTH = 43_200n
/** Measured epoch duration (~6.9 h on mainnet, Nov 2026); only a fallback when the chain cannot be read. */
export const TYPICAL_EPOCH_MS = 24_840_000

/** NEAR left on the account by `stake`, for gas and storage: 0.02 NEAR. */
export const DEFAULT_RESERVE = 2n * 10n ** 22n
/** Smallest stake the module sends: 0.001 NEAR (smaller deposits can round to zero pool shares). */
export const MIN_STAKE = 10n ** 21n
/**
 * Unstaked balances below this are share-rounding dust, not a withdrawal: pools leave 1–10 yoctoNEAR
 * behind (779 of the first 1 200 astro-stakers delegators on 2026-11-08). Dust is never offered as a
 * request or a claim and never triggers the withdraw-first batch: withdrawing it costs more gas than it is worth.
 */
export const UNSTAKED_DUST = 10n ** 21n
/** Default cap on a pool's reward fee, percent (pools can charge up to 100 %). */
export const DEFAULT_MAX_FEE = 10

/** Prepaid gas per call, from real mainnet transactions (deposit_and_stake burnt 27.7 Tgas, withdraw_all 26.5 Tgas). */
export const DEFAULT_GAS = {
  stake: 50n * TGAS,
  unstake: 50n * TGAS,
  withdraw: 125n * TGAS,
} as const

/**
 * Account-id suffixes of the staking-pool factories. A pool id is checked locally against these,
 * so a lying RPC cannot pass a foreign contract off as a pool.
 */
export const POOL_FACTORY_SUFFIXES: Record<NearNetwork, ReadonlyArray<{ suffix: string; factory: PoolFactory }>> = {
  mainnet: [
    { suffix: '.poolv1.near', factory: 'poolv1' },
    { suffix: '.pool.near', factory: 'pool' },
  ],
  testnet: [{ suffix: '.pool.f863973.m0', factory: 'testnet' }],
}

/** Which factory deployed a pool. */
export type PoolFactory = 'poolv1' | 'pool' | 'testnet'

/**
 * `code_hash` of the standard staking-pool contract builds seen in the validator sets. A pool whose
 * code is not one of these (or in the app's `codeHashes`) is refused for writes.
 */
export const KNOWN_POOL_CODE_HASHES: Record<NearNetwork, readonly string[]> = {
  // Every factory pool in the current + next sets on 2026-11-08 (360 accounts) has one of these four.
  mainnet: [
    'J1arLz48fgXcGyCPVckFwLnewNH6j1uw79thsvwqGYTY', // *.poolv1.near (213 pools)
    'AjD4YJaXgpiRdiArqnzyDi7Bkr1gJms9Z2w7Ev5esTKB', // *.pool.near (143 pools)
    'GGfKUF9TuAFN4AzbecPonNGuRTuVqx8UPXmViogN8pRm', // *.pool.near (metapool01, metatarz)
    '5vf2Jkqpk11H7szLnY4XdPA6maJi1ND8xe346xtbtX8e', // *.pool.near (aurora.pool.near)
  ],
  testnet: [
    'J1arLz48fgXcGyCPVckFwLnewNH6j1uw79thsvwqGYTY', // pool.f863973.m0 pools
  ],
}

/** Account excluded from the network APR: it receives the protocol treasury share, not delegator rewards. */
export const TREASURY_ACCOUNT = 'treasury.near'

/** fastnear's indexer API, used by `discover: 'fastnear'` to find the pools an account delegated to. */
export const FASTNEAR_API: Record<NearNetwork, string> = {
  mainnet: 'https://api.fastnear.com',
  testnet: 'https://test.api.fastnear.com',
}

/** How long display reads (pool details, validator set) are reused, ms. Write decisions always read fresh. */
export const DISPLAY_TTL_MS = 5 * 60_000
/** Reads in flight at once. */
export const DEFAULT_CONCURRENCY = 4
