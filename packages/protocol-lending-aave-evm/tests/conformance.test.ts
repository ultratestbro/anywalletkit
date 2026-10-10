import { describeProtocolModule } from '@forgewallet/conformance'
import { AaveProtocolEvm } from '../src/index.js'
import { makeMarket, USDT } from './fixture.js'

const { chain } = makeMarket()

describeProtocolModule('protocol-lending-aave-evm', {
  type: 'lending',
  Protocol: AaveProtocolEvm as never,
  config: { chainId: 1, market: 'core', provider: chain.provider },
  samples: {
    quoteSupply: [{ token: USDT, amount: 1_000_000n }],
    quoteWithdraw: [{ token: USDT, amount: 1_000_000n }],
    quoteBorrow: [{ token: USDT, amount: 1_000_000n }],
    quoteRepay: [{ token: USDT, amount: 1_000_000n }],
  },
})
