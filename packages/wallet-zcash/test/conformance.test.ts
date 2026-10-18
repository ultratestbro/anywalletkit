import { describeChainModule } from '@forgewallet/conformance'
import { WalletManagerZcash, type WalletAccountZcash } from '../src/index.js'

describeChainModule('wallet-zcash', {
  chain: 'zcash',
  create: (seed) => new WalletManagerZcash(seed, { network: 'mainnet' }),
  fromSigner: (signer) => new WalletManagerZcash(signer, { network: 'mainnet' }),
  curve: 'secp256k1',
  publicKeyOf: async (a) => (a as WalletAccountZcash).publicKey,
})
