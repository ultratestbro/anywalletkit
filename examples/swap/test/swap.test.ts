import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@forgewallet/conformance'
import { Wallet } from '@forgewallet/kit'
import { WalletManagerEvm } from '@forgewallet/wallet-evm'
import { RouterSwap2Protocol, type Swap2Route } from '@forgewallet/protocol-swap2-router'
import { bestQuote, providers, routePicker, swapsFor, usdcToBase } from '../src/swap.ts'
import { walletWithSwaps } from '../src/kit.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!

describe('Swaps guide (docs) — offline', () => {
  it('builds the router over every provider of the guide', () => {
    const names = providers().map((p) => p.name)
    expect(names).toEqual(expect.arrayContaining(['lifi', 'thorchain', 'cctp']))
    expect(names.length).toBe(6)
  })

  it('binds the router to the account chain and the kit hands it out', async () => {
    const wallet = walletWithSwaps(SEED)
    try {
      const swaps = await wallet.getProtocol<RouterSwap2Protocol>('swap')
      expect(swaps).toBeInstanceOf(RouterSwap2Protocol)
      const options = await usdcToBase(await wallet.getAccount('eip155:1'))
      expect(options.recipient).toBe(derivationVectors.vectors.evm['bip39-abandon-12']!.accounts[0]!.address)
    } finally {
      wallet.dispose()
    }
  })
})

// Real providers over the network: LIVE=1 pnpm --filter @forgewallet/example-swap test
describe.runIf(process.env.LIVE === '1')('Swaps guide (docs) — live quotes, nothing signed', () => {
  it('quotes USDC Ethereum → Base and lists ranked routes', async () => {
    const wallet = new Wallet(SEED)
    wallet.registerWallet('eip155:1', WalletManagerEvm, { provider: 'https://ethereum-rpc.publicnode.com', chainId: 1 })
    try {
      const account = await wallet.getAccount('eip155:1')
      const swaps = swapsFor(account)
      const options = await usdcToBase(account)
      const best = await bestQuote(swaps, options)
      expect(best.atLeast > 0n).toBe(true)
      const snapshots: number[] = []
      const routes = await routePicker(swaps, options, (r: Swap2Route[]) => snapshots.push(r.length))
      console.table(routes.map((r) => ({ provider: r.provider, atLeast: r.quote.toTokenAmountMin, eta: r.quote.estimatedDuration, tags: r.tags.join(',') })))
      expect(routes.length).toBeGreaterThan(0)
      expect(routes.some((r) => r.tags.includes('best'))).toBe(true)
      expect(snapshots.length).toBeGreaterThan(0)
      swaps.close()
    } finally {
      wallet.dispose()
    }
  }, 60_000)
})
