import { describeChainModule } from '@forgewallet/conformance'
import { WalletManagerBtc, type WalletAccountBtc } from '../src/index.js'

describeChainModule('wallet-btc', {
  chain: 'btc',
  create: (seed) => new WalletManagerBtc(seed, { network: 'bitcoin' }),
  publicKeyOf: async (a) => (a as WalletAccountBtc).publicKey,
})
