import { describeChainModule } from '@forgewallet/conformance'
import { WalletManagerTron, type WalletAccountTron } from '../src/index.js'

describeChainModule('wallet-tron', {
  chain: 'tron',
  create: (seed) => new WalletManagerTron(seed),
  fromSigner: (signer) => new WalletManagerTron(signer),
  curve: 'secp256k1',
  publicKeyOf: async (a) => (a as WalletAccountTron).publicKey,
})
