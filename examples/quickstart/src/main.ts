// Runs the Quickstart against mainnet RPCs with a fresh, empty seed: addresses and balances.
// pnpm --filter @forgewallet/example-quickstart start
import { addresses, createWallet, ethBalance, newSeedPhrase } from './wallet.ts'

const wallet = createWallet(process.env.SEED_PHRASE ?? newSeedPhrase())
try {
  console.table(await addresses(wallet))
  console.log('ETH balance (wei):', await ethBalance(wallet))
} finally {
  wallet.dispose()
}
