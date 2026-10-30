'use strict'
import './src/buffer-global.js'

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
export { default as TONSTAKERS_ADDRESS_MAP } from './src/tonstakers-address-map.js'
export {
  OP_STAKE, OP_UNSTAKE, STAKE_FEE_RESERVE, UNSTAKE_FEE_RESERVE, MIN_STAKE,
  buildStakeBody, buildUnstakeBody, TONSTAKERS_JETTON_WALLET_CODES, deriveTonstakersJettonWallet
} from './src/tonstakers-protocol-ton.js'

export { describeTonstakersActivity, rawAddress, OP_WITHDRAWAL_PAYOUT } from './src/tonstakers-activity.js'
export { default } from './src/tonstakers-protocol-ton.js'
