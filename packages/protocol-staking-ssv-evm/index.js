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
export { default as SSV_ADDRESS_MAP } from './src/ssv-address-map.js'
export { SSV_ERRORS, describeRevert, MINIMAL_STAKING_AMOUNT, ETH_CLAIM_UNIT } from './src/ssv-protocol-evm.js'

export { default } from './src/ssv-protocol-evm.js'
