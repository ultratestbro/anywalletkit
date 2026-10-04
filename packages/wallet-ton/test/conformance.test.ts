import { describeChainModule } from '@forgewallet/conformance'
import { WalletManagerTon, type WalletAccountTon } from '../src/index.js'

describeChainModule('wallet-ton', {
  chain: 'ton',
  create: (seed) => new WalletManagerTon(seed),
  publicKeyOf: async (a) => (a as WalletAccountTon).publicKey,
})
