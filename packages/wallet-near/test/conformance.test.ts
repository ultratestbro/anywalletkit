import { describeChainModule } from '@anywalletkit/conformance'
import { WalletManagerNear, type WalletAccountNear } from '../src/index.js'

describeChainModule('wallet-near', {
  chain: 'near',
  create: (seed) => new WalletManagerNear(seed),
  fromSigner: (signer) => new WalletManagerNear(signer),
  curve: 'ed25519',
  publicKeyOf: async (a) => (a as WalletAccountNear).publicKey.data,
})
