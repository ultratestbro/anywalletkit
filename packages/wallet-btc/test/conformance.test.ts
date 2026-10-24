import { describeChainModule } from '@anywalletkit/conformance'
import { WalletManagerBtc, type WalletAccountBtc } from '../src/index.js'

describeChainModule('wallet-btc', {
  chain: 'btc',
  create: (seed) => new WalletManagerBtc(seed, { network: 'bitcoin' }),
  fromSigner: (signer) => new WalletManagerBtc(signer, { network: 'bitcoin' }),
  curve: 'secp256k1',
  publicKeyOf: async (a) => (a as WalletAccountBtc).publicKey,
})
