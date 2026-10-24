// The suites must pass against the base classes themselves (everything notImplemented).
import { LendingProtocol, StakingProtocol } from '@anywalletkit/core'
import { describeProtocolModule } from '../src/index.js'

describeProtocolModule('LendingProtocol base', {
  type: 'lending', Protocol: LendingProtocol,
  notImplemented: ['supply', 'withdraw', 'borrow', 'repay', 'quoteSupply', 'quoteWithdraw', 'quoteBorrow', 'quoteRepay'],
})
describeProtocolModule('StakingProtocol base', {
  type: 'staking', Protocol: StakingProtocol,
  notImplemented: ['stake', 'requestWithdrawal', 'claimWithdrawals', 'quoteStake', 'quoteRequestWithdrawal', 'quoteClaimWithdrawals', 'getWithdrawalRequests', 'getStakedBalance', 'getApr'],
})
