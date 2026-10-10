import { describeChainModule } from '@forgewallet/conformance'
import { WalletManagerNear, type WalletAccountNear } from '../src/index.js'

describeChainModule('wallet-near', {
  chain: 'near',
  create: (seed) => new WalletManagerNear(seed),
  publicKeyOf: async (a) => (a as WalletAccountNear).publicKey.data,
})
