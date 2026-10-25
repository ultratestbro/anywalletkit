import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { LocalSigner, WalletManager, seedFromMnemonicSync, type FeeRates, type IWalletAccount } from '../src/index.js'

// A Node Buffer (or any Uint8Array view) shares memory on `.slice()`: the SDK must take a real copy,
// so the caller zeroizing its input cannot change keys, and the SDK zeroizing on dispose cannot wipe
// the caller's bytes.
const SEED = seedFromMnemonicSync('test test test test test test test test test test test junk')
const EVM0 = "m/44'/60'/0'/0/0"
const digest = sha256(new TextEncoder().encode('anywalletkit'))

const asBuffer = () => Buffer.from(SEED)
/** A view into a larger buffer, the other shape whose `.slice()` used to share memory. */
const asSubarray = () => { const big = new Uint8Array(96); big.set(SEED, 16); return Buffer.from(big.buffer, 16, 64) }

class SeedManager extends WalletManager<IWalletAccount, Record<string, never>> {
  async getAccount(): Promise<IWalletAccount> { throw new Error('unused') }
  async getAccountByPath(): Promise<IWalletAccount> { throw new Error('unused') }
  async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 1n, fast: 1n } }
  seed(): string { return bytesToHex(this.seedBytes()) }
}

describe.each([['Buffer', asBuffer], ['Buffer view at an offset', asSubarray]])('seed input as a %s', (_, make) => {
  it('LocalSigner.fromSeed: zeroizing the input does not change derived children', async () => {
    const reference = await (await LocalSigner.fromSeed(SEED, 'secp256k1', EVM0).derive('1')).sign(digest)
    const input = make()
    const signer = LocalSigner.fromSeed(input, 'secp256k1', EVM0)
    input.fill(0)
    const child = await signer.derive('1')
    expect(bytesToHex(await child.sign(digest))).toBe(bytesToHex(reference))
  })

  it('LocalSigner.dispose does not wipe the caller\'s input', () => {
    const input = make()
    LocalSigner.fromSeed(input, 'secp256k1', EVM0).dispose()
    expect(bytesToHex(input)).toBe(bytesToHex(SEED))
  })

  it('WalletManager keeps its own copy and does not wipe the input on dispose', () => {
    const input = make()
    const manager = new SeedManager(input, {})
    input.fill(0)
    expect(manager.seed()).toBe(bytesToHex(SEED))
    const other = make()
    new SeedManager(other, {}).dispose()
    expect(bytesToHex(other)).toBe(bytesToHex(SEED))
  })
})
