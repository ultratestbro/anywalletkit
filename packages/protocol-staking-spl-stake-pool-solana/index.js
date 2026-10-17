'use strict'

/** @typedef {import('./src/staking-protocol.js').StakeOptions} StakeOptions */
/** @typedef {import('./src/staking-protocol.js').StakeResult} StakeResult */
/** @typedef {import('./src/staking-protocol.js').WithdrawalRequestOptions} WithdrawalRequestOptions */
/** @typedef {import('./src/staking-protocol.js').WithdrawalRequestResult} WithdrawalRequestResult */
/** @typedef {import('./src/staking-protocol.js').WithdrawalRequest} WithdrawalRequest */
/** @typedef {import('./src/staking-protocol.js').WithdrawalRequestsView} WithdrawalRequestsView */
/** @typedef {import('./src/staking-protocol.js').ClaimWithdrawalsOptions} ClaimWithdrawalsOptions */
/** @typedef {import('./src/staking-protocol.js').ClaimWithdrawalsResult} ClaimWithdrawalsResult */
/** @typedef {import('./src/staking-protocol.js').StakedBalance} StakedBalance */
/** @typedef {import('./src/spl-stake-pool-address-map.js').StakePoolConfig} StakePoolConfig */

export { default as StakingProtocol, IStakingProtocol } from './src/staking-protocol.js'
export { default as SPL_STAKE_POOL_ADDRESS_MAP } from './src/spl-stake-pool-address-map.js'
export * as codec from './src/spl-stake-pool-codec.js'
export {
  DEFAULT_COMPUTE_UNIT_LIMIT, DEFAULT_COMPUTE_UNIT_PRICE, DEFAULT_SLIPPAGE_BPS, DEFAULT_UNSTAKE_SLOTS,
  parseDepositSol, base58Decode
} from './src/spl-stake-pool-protocol-solana.js'

export { describeStakePoolActivity, INSTRUCTION_ACTIONS } from './src/spl-stake-pool-activity.js'
export { default } from './src/spl-stake-pool-protocol-solana.js'
