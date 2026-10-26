// Monad staking precompile constants (docs.monad.xyz/reference/staking/api, checked on mainnet 2026-10-26).

/** The staking precompile. Only CALL works on it (no STATICCALL, DELEGATECALL, CALLCODE); `eth_call` is fine. */
export const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000001000' as const

/** Monad mainnet and testnet chain ids. */
export const MONAD_MAINNET = 143
export const MONAD_TESTNET = 10143
export const MONAD_CHAIN_IDS = [MONAD_MAINNET, MONAD_TESTNET] as const
export type MonadChainId = (typeof MONAD_CHAIN_IDS)[number]

const MON = 10n ** 18n

/** Smallest single delegation: 1 gwei. */
export const DUST_THRESHOLD = 10n ** 9n
/** Epochs between a stake deactivating and the withdrawal opening. */
export const WITHDRAWAL_DELAY = 1n
/** Blocks between boundary blocks (~4 h 12 min); rounds, not blocks, define epochs, so never derive the epoch from it. */
export const BOUNDARY_BLOCK_PERIOD = 50_000n
/** Rounds between the boundary block and the start of the next epoch. */
export const EPOCH_DELAY_ROUNDS = 5_000n
/** Self-stake a validator's auth address needs to stay eligible. */
export const MIN_AUTH_ADDRESS_STAKE = 100_000n * MON
/** Total stake a validator needs for the active set. */
export const ACTIVE_VALIDATOR_STAKE = 10_000_000n * MON
/** Validators in the consensus (active) set. */
export const ACTIVE_VALSET_SIZE = 200
/** MON minted per block, split between the proposer's commission and its delegators. */
export const BLOCK_REWARD = 18n * MON
/** 100 % commission, in the precompile's 1e18 scale. */
export const MAX_COMMISSION = MON
/** Largest page the paginated reads return. */
export const PAGINATED_RESULTS_SIZE = 100
/** Withdrawal ids per (validator, delegator): 0..255. */
export const MAX_WITHDRAW_ID = 255
/**
 * Monad's reserve balance: a transaction whose value spend leaves the sender below 10 MON reverts
 * (outside the narrow "emptying transaction" exception, which simulation cannot see). Stakes keep it.
 */
export const USER_RESERVE_BALANCE = 10n * MON
