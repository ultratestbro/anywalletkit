import { describeChainModule } from '@forgewallet/conformance'
import { WalletManagerSolana, type WalletAccountSolana } from '../src/index.js'

describeChainModule('wallet-solana', {
  chain: 'solana',
  create: (seed) => new WalletManagerSolana(seed),
  publicKeyOf: async (a) => (a as WalletAccountSolana).publicKey,
})
