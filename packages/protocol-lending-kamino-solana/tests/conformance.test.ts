import { describeProtocolModule } from '@forgewallet/conformance'
import { KaminoMarketProtocolSolana, KaminoVaultProtocolSolana } from '../src/index.js'
import { USDC, VAULT, account, api, obligation } from './fixture.js'

const f = api()
f.obligations = [obligation]
f.position = { stakedShares: '10', unstakedShares: '0', totalShares: '10' }

describeProtocolModule('protocol-lending-kamino-solana (vault)', {
  type: 'lending',
  Protocol: KaminoVaultProtocolSolana as never,
  config: { vault: VAULT, fetch: f.fetch },
  account: () => account(),
  notImplemented: ['borrow', 'repay', 'quoteBorrow', 'quoteRepay'],
  samples: { quoteSupply: [{ amount: 1_000_000n }], quoteWithdraw: [{ amount: 'max' }] },
})

describeProtocolModule('protocol-lending-kamino-solana (market)', {
  type: 'lending',
  Protocol: KaminoMarketProtocolSolana as never,
  config: { fetch: f.fetch },
  account: () => account(),
  samples: {
    quoteSupply: [{ token: USDC, amount: 1_000_000n }],
    quoteWithdraw: [{ token: USDC, amount: 1_000_000n }],
    quoteBorrow: [{ token: USDC, amount: 1_000_000n }],
    quoteRepay: [{ token: USDC, amount: 1_000_000n }],
  },
})
