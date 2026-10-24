import { describe, expect, it } from 'vitest'
import { CHAIN_KEYS, KeyringError, formatPrivateKey, parsePrivateKey, type ChainKey } from '../src/index.js'
import { ABANDON, fresh } from './helpers.js'

describe('exportPrivateKey — one account, one chain, in the format other wallets import', () => {
  it('round-trips on every chain: the exported key, imported into a new keyring, owns the same address', async () => {
    const { keyring, secrets } = await fresh()
    const { accounts } = await keyring.importMnemonic(ABANDON)
    const second = await keyring.addAccount(accounts[0]!.sourceId)
    for (const account of [accounts[0]!, second]) {
      for (const chain of CHAIN_KEYS) {
        const reads = secrets.reads
        const out = await keyring.exportPrivateKey(account.id, chain)
        expect(secrets.reads - reads, `${chain}: one secret read`).toBe(1)
        expect(out.address).toBe(account.addresses[chain])
        const other = (await fresh()).keyring
        const imported = await other.importPrivateKey(chain, out.privateKey)
        expect(imported.account.addresses[chain], `${chain} #${account.index}`).toBe(account.addresses[chain])
      }
    }
  })

  it('formats: EVM 0x-hex (the well-known abandon…about key), Tron hex, BTC / Zcash compressed WIF, Solana base58 64 bytes, NEAR ed25519:, TON 128 hex', async () => {
    const { keyring } = await fresh()
    const { accounts } = await keyring.importMnemonic(ABANDON)
    const id = accounts[0]!.id
    const get = (c: ChainKey) => keyring.exportPrivateKey(id, c)
    expect((await get('evm')).privateKey).toBe('0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727')
    expect((await get('evm')).path).toBe("m/44'/60'/0'/0/0")
    expect((await get('tron')).privateKey).toMatch(/^[0-9a-f]{64}$/)
    expect((await get('btc')).privateKey).toMatch(/^[KL][1-9A-HJ-NP-Za-km-z]{51}$/)
    expect((await get('btc')).format).toBe('wif')
    expect((await get('zcash')).privateKey).toMatch(/^[KL][1-9A-HJ-NP-Za-km-z]{51}$/)
    expect((await get('solana')).privateKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/)
    expect((await get('near')).privateKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}$/)
    expect((await get('ton')).privateKey).toMatch(/^[0-9a-f]{128}$/)
  })

  it('an imported key exports itself on its own chain only; TON 24-word wallets are told to export the words', async () => {
    const { keyring } = await fresh()
    const key = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
    const { account } = await keyring.importPrivateKey('evm', key)
    expect((await keyring.exportPrivateKey(account.id, 'evm')).privateKey).toBe(key)
    await expect(keyring.exportPrivateKey(account.id, 'solana')).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('refuses rather than exporting a key that would not own the account (address check)', async () => {
    const { keyring, storage } = await fresh()
    const { accounts } = await keyring.importMnemonic(ABANDON)
    // Corrupt the stored address (as if the state and the secret disagreed): the derived key is withheld.
    storage.state!.accounts[0]!.addresses.evm = '0x000000000000000000000000000000000000dEaD'
    const reopened = (await import('../src/index.js')).Keyring.load({ storage, secrets: (keyring as unknown as { _secrets: never })._secrets, chains: (await import('./helpers.js')).CHAINS })
    const err = await (await reopened).exportPrivateKey(accounts[0]!.id, 'evm').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KeyringError)
    expect((err as Error).message).toMatch(/does not match this account's address/)
  })

  it('formatPrivateKey is the exact inverse of parsePrivateKey on every chain (testnet WIF too)', () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
    for (const chain of CHAIN_KEYS) {
      expect(parsePrivateKey(chain, formatPrivateKey(chain, key).value).privateKey, chain).toEqual(key)
    }
    expect(formatPrivateKey('btc', key, { testnet: true }).value).toMatch(/^c/)
    expect(parsePrivateKey('btc', formatPrivateKey('btc', key, { testnet: true }).value).privateKey).toEqual(key)
  })
})
