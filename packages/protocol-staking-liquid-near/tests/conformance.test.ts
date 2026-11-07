import { createMockAccount, describeProtocolModule } from '@anywalletkit/conformance'
import { LiquidStakingProtocolNear, poolRequestId } from '../src/index.js'
import { ALICE, EPOCH, FakeNear, LINEAR, NEAR } from './fake-near.js'
import { loadFixtures } from './fixtures.js'

// Alice holds LiNEAR and has an unlocked, payable unstaked balance: every quote and read resolves.
const node = new FakeNear()
node.stakeFor(ALICE, 40n * NEAR)
node.unstakedFor(ALICE, 2n * NEAR, EPOCH - 1n)

describeProtocolModule('protocol-staking-liquid-near', {
  type: 'staking',
  Protocol: LiquidStakingProtocolNear as never,
  config: { pool: 'linear', provider: node.fetch, archivalProvider: node.fetch },
  account: () => createMockAccount({ chain: 'near:mainnet', address: ALICE, fee: 10n ** 21n }),
  samples: {
    quoteStake: [{ amount: NEAR }],
    quoteRequestWithdrawal: [{ amount: NEAR }],
    quoteClaimWithdrawals: [{ ids: [poolRequestId(LINEAR)] }],
    getWithdrawalRequests: [],
    getStakedBalance: [],
    getApr: [],
    stake: [{ amount: NEAR }],
    requestWithdrawal: [{ amount: 'all' }],
    claimWithdrawals: [{}],
  },
  mustResolve: ['quoteStake', 'quoteRequestWithdrawal', 'quoteClaimWithdrawals', 'getWithdrawalRequests', 'getStakedBalance', 'getApr'],
  activity: { fixtures: loadFixtures('.'), negatives: loadFixtures('negatives') },
})
