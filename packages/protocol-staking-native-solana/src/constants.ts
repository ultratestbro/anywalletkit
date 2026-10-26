/** CAIP-2 id of Solana mainnet. */
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

/** The native Stake program (Core BPF since 2025; still at the old address). */
export const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111'
export const SYSTEM_PROGRAM = '11111111111111111111111111111111'
export const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111'
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

export const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111'
export const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111'
export const SYSVAR_STAKE_HISTORY = 'SysvarStakeHistory1111111111111111111111111'
/** Legacy stake config account. The program ignores it but still accepts it in `DelegateStake`'s legacy layout. */
export const STAKE_CONFIG = 'StakeConfig11111111111111111111111111111111'

/**
 * Epoch from which warm-up and cool-down run at 9 % of the cluster per epoch. The stake program uses 0
 * ("as if it had always been 9 %"), which is exact for every present-day decision it makes; this module
 * does the same, so its statuses match what the program will accept.
 */
export const RATE_CHANGE_EPOCH = 0n

/** Size of a stake account (`StakeStateV2`). */
export const STAKE_ACCOUNT_SPACE = 200
/** Longest seed `CreateAccountWithSeed` accepts, in bytes. */
export const MAX_SEED_LENGTH = 32

export const LAMPORTS_PER_SOL = 1_000_000_000n
export const U64_MAX = 0xffff_ffff_ffff_ffffn
