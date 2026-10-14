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

export { default as StakingProtocol, IStakingProtocol } from './src/staking-protocol.js'
export { default as LIDO_ADDRESS_MAP } from './src/lido-address-map.js'
export { splitWithdrawalAmounts } from './src/lido-protocol-evm.js'

export { describeLidoActivity, LIDO_ACTIONS } from './src/lido-activity.js'
export { default } from './src/lido-protocol-evm.js'
