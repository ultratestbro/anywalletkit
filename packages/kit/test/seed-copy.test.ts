import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { WalletManager, seedFromMnemonicSync, type FeeRates, type IWalletAccount } from '@anywalletkit/core'
import { createMockAccount } from '@anywalletkit/conformance'
import { Wallet } from '../src/index.js'

const SEED = seedFromMnemonicSync('test test test test test test test test test test test junk')
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

/** Reports the seed it was built from as the account's address. */
class SeedEcho extends WalletManager<IWalletAccount, Record<string, never>> {
  async getAccount() { return this.getAccountByPath() }
  async getAccountByPath() { return createMockAccount({ chain: 'eip155:1', address: hex(this.seedBytes()) }) }
  async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 1n, fast: 1n } }
}

describe('Wallet(seed bytes) keeps an independent copy', () => {
  it('zeroizing the caller\'s Buffer after construction does not change what managers derive from', async () => {
    const input = Buffer.from(SEED)
    const wallet = new Wallet(input)
    wallet.registerWallet('eip155:1', SeedEcho, {})
    input.fill(0)
    expect(await (await wallet.getAccount('eip155:1')).getAddress()).toBe(hex(SEED))
  })

  it('dispose() zeroizes the wallet\'s copy, not the caller\'s Buffer', () => {
    const input = Buffer.from(SEED)
    new Wallet(input).dispose()
    expect(hex(input)).toBe(hex(SEED))
  })
})
