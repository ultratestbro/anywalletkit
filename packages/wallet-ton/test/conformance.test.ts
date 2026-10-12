import { describeChainModule } from '@forgewallet/conformance'
import { WalletManagerTon, type WalletAccountTon } from '../src/index.js'

describeChainModule('wallet-ton', {
  chain: 'ton',
  create: (seed) => new WalletManagerTon(seed),
  fromSigner: (signer) => new WalletManagerTon(signer),
  curve: 'ed25519',
  publicKeyOf: async (a) => (a as WalletAccountTon).publicKey,
})
