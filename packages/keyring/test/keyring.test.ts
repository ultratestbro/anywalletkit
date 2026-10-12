import { describe, expect, it } from 'vitest'
import { base58, hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { mnemonicNew } from '@ton/crypto'
import { deriveEd25519, deriveSecp256k1, seedFromMnemonicSync } from '@forgewallet/core'
import { WalletManagerTon } from '@forgewallet/wallet-ton'
import { CHAIN_SPECS, Keyring, KeyringError, parsePrivateKey, type ChainKey } from '../src/index.js'
import { ABANDON, CHAINS, fresh } from './helpers.js'

const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

/** Account 2's raw key on `chain`, from the ABANDON seed. */
function keyAt(chain: ChainKey): Uint8Array {
  const seed = seedFromMnemonicSync(ABANDON)
  const path = CHAIN_SPECS[chain].accountPath(2)
  return CHAIN_SPECS[chain].curve === 'secp256k1' ? deriveSecp256k1(seed, path).privateKey : deriveEd25519(seed, path).privateKey
}
const secret64 = (seed: Uint8Array) => Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)])
function wif(key: Uint8Array): string {
  const body = Uint8Array.from([0x80, ...key, 0x01])
  return base58.encode(Uint8Array.from([...body, ...sha256(sha256(body)).subarray(0, 4)]))
}

/** Every format the import screen accepts, for account 2's key. */
const FORMATS: Record<ChainKey, (k: Uint8Array) => string[]> = {
  evm: (k) => [`0x${hex.encode(k)}`, hex.encode(k).toUpperCase()],
  tron: (k) => [hex.encode(k)],
  btc: (k) => [wif(k), hex.encode(k)],
  solana: (k) => [base58.encode(secret64(k)), JSON.stringify([...secret64(k)]), base58.encode(k)],
  ton: (k) => [hex.encode(secret64(k)), hex.encode(k)],
  near: (k) => [`ed25519:${base58.encode(secret64(k))}`],
}

describe('Keyring — many accounts from one seed', () => {
  it('adds accounts at the next index, names them, keeps the first active', async () => {
    const { keyring } = await fresh()
    const { source, accounts } = await keyring.importMnemonic(ABANDON, { label: 'Main' })
    expect(accounts.map((a) => a.id)).toEqual([`${source.id}/0`])
    const second = await keyring.addAccount(source.id)
    expect(second).toMatchObject({ index: 1, name: 'Account 2' })
    expect(keyring.activeAccount?.id).toBe(accounts[0]!.id)
    await keyring.setHidden(second.id, true)
    const third = await keyring.addAccount(source.id, { name: 'Savings' })
    expect(third.index).toBe(2) // a hidden index is never reused
    expect(keyring.listAccounts().map((a) => a.index)).toEqual([0, 2])
    expect(keyring.listAccounts({ includeHidden: true })).toHaveLength(3)
  })

  it('rename / hide / active rules', async () => {
    const { keyring } = await fresh()
    const { source, accounts } = await keyring.importMnemonic(ABANDON)
    const b = await keyring.addAccount(source.id)
    await keyring.renameAccount(b.id, '  Trading  ')
    expect(keyring.getAccountMeta(b.id).name).toBe('Trading')
    await expect(keyring.renameAccount(b.id, ' ')).rejects.toThrow(KeyringError)
    await keyring.setActiveAccount(b.id)
    await keyring.setHidden(b.id, true)
    expect(keyring.activeAccount?.id).toBe(accounts[0]!.id) // hiding the active one moves "active"
    await expect(keyring.setHidden(accounts[0]!.id, true)).rejects.toThrow(/at least one account visible/)
    await expect(keyring.setActiveAccount(b.id)).rejects.toThrow(/Show the account/)
  })

  it('discovers used accounts on restore and stops after the gap limit', async () => {
    const { keyring } = await fresh({ evm: CHAINS.evm })
    const used = new Set([1, 2, 4]) // 3 is a gap
    const probed: number[] = []
    const isUsed = async (_: unknown, i: number) => { probed.push(i); return used.has(i) }
    const gap1 = await keyring.importMnemonic(ABANDON, { discover: { isUsed } })
    expect(gap1.accounts.map((a) => a.index)).toEqual([0, 1, 2]) // stops at the first unused (3)
    expect(probed).toEqual([1, 2, 3])
    const { keyring: k2 } = await fresh({ evm: CHAINS.evm })
    const gap2 = await k2.importMnemonic(ABANDON, { discover: { isUsed, gapLimit: 2 } })
    expect(gap2.accounts.map((a) => a.index)).toEqual([0, 1, 2, 4])
  })

  it('a passphrase is a different wallet; the same phrase + passphrase is a duplicate', async () => {
    const { keyring } = await fresh({ evm: CHAINS.evm })
    const plain = await keyring.importMnemonic(ABANDON)
    const withPass = await keyring.importMnemonic(ABANDON, { passphrase: 'TREZOR' })
    expect(withPass.source.hasPassphrase).toBe(true)
    expect(withPass.accounts[0]!.addresses.evm).not.toBe(plain.accounts[0]!.addresses.evm)
    await expect(keyring.importMnemonic(`  ${ABANDON.toUpperCase()} `)).rejects.toMatchObject({ code: 'duplicate' })
    await expect(keyring.importMnemonic(ABANDON, { passphrase: 'TREZOR' })).rejects.toMatchObject({ code: 'duplicate' })
  })

  it('rejects bad phrases with a reason and never echoes the words', async () => {
    const { keyring } = await fresh({ evm: CHAINS.evm })
    await expect(keyring.importMnemonic('abandon abandon')).rejects.toThrow(/12, 15, 18, 21 or 24 words; this one has 2/)
    const bad = ABANDON.replace(/about$/, 'abandon')
    const err = await keyring.importMnemonic(bad).catch((e: Error) => e)
    expect(String(err)).toMatch(/checksum/)
    expect(String(err)).not.toMatch(/abandon/)
  })

  it('creates a fresh seed, returns the phrase once, stores it only in SecretStorage', async () => {
    const { keyring, storage, secrets } = await fresh({ evm: CHAINS.evm })
    const { mnemonic, account, source } = await keyring.createMnemonic({ words: 24 })
    expect(mnemonic.split(' ')).toHaveLength(24)
    expect(account.addresses.evm).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(JSON.stringify(storage.state)).not.toContain(mnemonic.split(' ')[0]! + ' ' + mnemonic.split(' ')[1]!)
    expect(JSON.parse(secrets.map.get(source.id)!)).toEqual({ type: 'mnemonic', mnemonic })
  })

  it('reopens from storage with the same accounts and never reads a secret to list them', async () => {
    const { keyring, storage, secrets } = await fresh()
    const { source } = await keyring.importMnemonic(ABANDON)
    await keyring.addAccount(source.id)
    const reads = secrets.reads
    const again = await Keyring.load({ storage, secrets, chains: CHAINS })
    expect(again.listAccounts()).toEqual(keyring.listAccounts())
    expect(again.activeAccount).toEqual(keyring.activeAccount)
    expect(secrets.reads).toBe(reads)
  })

  it('a failed save leaves the keyring unchanged', async () => {
    const { keyring, storage } = await fresh({ evm: CHAINS.evm })
    const { source } = await keyring.importMnemonic(ABANDON)
    storage.failNext = true
    await expect(keyring.addAccount(source.id)).rejects.toThrow('disk full')
    expect(keyring.listAccounts()).toHaveLength(1)
    expect((await keyring.addAccount(source.id)).index).toBe(1)
  })

  it('signs through a disposable handle that matches the stored address', async () => {
    const { keyring } = await fresh()
    const { source } = await keyring.importMnemonic(ABANDON)
    const b = await keyring.addAccount(source.id)
    for (const chain of keyring.chains) {
      const handle = await keyring.getAccount(b.id, chain)
      expect(await handle.account.getAddress()).toBe(b.addresses[chain])
      handle.dispose()
      await expect(handle.account.sign('hi')).rejects.toThrow(/disposed/)
    }
    const sig = await keyring.withAccount(b.id, 'evm', (a) => a.sign('hello'))
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
  })
})

describe('Keyring — imported private keys', () => {
  for (const chain of Object.keys(FORMATS) as ChainKey[]) {
    it(`${chain}: every accepted format imports to the address the seed gives that key`, async () => {
      const seedAccount = await (async () => {
        const { keyring } = await fresh({ [chain]: CHAINS[chain] })
        const { source } = await keyring.importMnemonic(ABANDON)
        await keyring.addAccount(source.id)
        return (await keyring.addAccount(source.id)).addresses[chain]
      })()
      for (const input of FORMATS[chain](keyAt(chain))) {
        const { keyring, storage } = await fresh({ [chain]: CHAINS[chain] })
        expect(await keyring.previewPrivateKey(chain, input)).toBe(seedAccount)
        expect(storage.saves).toBe(0) // preview stores nothing
        const { account, source } = await keyring.importPrivateKey(chain, input)
        expect(account).toMatchObject({ id: source.id, index: null, addresses: { [chain]: seedAccount } })
        expect(source).toMatchObject({ type: 'privateKey', chain })
      }
    })
  }

  it('a key account has one address: no other chain, no other index, no addAccount', async () => {
    const { keyring } = await fresh()
    const { account, source } = await keyring.importPrivateKey('evm', `0x${hex.encode(keyAt('evm'))}`)
    expect(Object.keys(account.addresses)).toEqual(['evm'])
    await expect(keyring.getAccount(account.id, 'solana')).rejects.toThrow(/no solana address/)
    await expect(keyring.addAccount(source.id)).rejects.toMatchObject({ code: 'unsupported' })
    const handle = await keyring.getAccount(account.id, 'evm')
    const manager = new CHAINS.evm.Manager((await import('@forgewallet/core')).privateKeySigner('secp256k1', keyAt('evm')), {})
    await expect(manager.getAccount(1)).rejects.toThrow(/one account/)
    manager.dispose()
    handle.dispose()
  })

  it('the same key twice is a duplicate, whatever the format', async () => {
    const { keyring } = await fresh({ solana: CHAINS.solana })
    const [b58, json] = FORMATS.solana(keyAt('solana'))
    await keyring.importPrivateKey('solana', b58!)
    await expect(keyring.importPrivateKey('solana', json!)).rejects.toMatchObject({ code: 'duplicate' })
  })

  it('refuses malformed keys with a reason', () => {
    expect(() => parsePrivateKey('evm', '0x1234')).toThrow(/64 hex/)
    expect(() => parsePrivateKey('evm', `0x${'00'.repeat(32)}`)).toThrow(/not a valid secp256k1/)
    expect(() => parsePrivateKey('near', 'abc')).toThrow(/ed25519:/)
    const w = wif(keyAt('btc'))
    expect(() => parsePrivateKey('btc', `${w.slice(0, -1)}${w.endsWith('1') ? '2' : '1'}`)).toThrow(/checksum|WIF/)
    const s = secret64(keyAt('solana'))
    s[40] = s[40]! ^ 1
    expect(() => parsePrivateKey('solana', base58.encode(s))).toThrow(/does not match its own public key/)
    expect(() => parsePrivateKey('solana', '[1,2,300]')).toThrow(/bytes/)
  })

  it('export returns the canonical key; removal deletes the secret and the account', async () => {
    const { keyring, secrets } = await fresh()
    const main = await keyring.importMnemonic(ABANDON)
    const { source, account } = await keyring.importPrivateKey('tron', hex.encode(keyAt('tron')))
    expect(await keyring.exportSecret(source.id)).toEqual({ type: 'privateKey', secret: hex.encode(keyAt('tron')), chain: 'tron' })
    await keyring.setActiveAccount(account.id)
    await keyring.removeSource(source.id)
    expect(secrets.map.has(source.id)).toBe(false)
    expect(keyring.listAccounts().map((a) => a.id)).toEqual([`${main.source.id}/0`])
    expect(keyring.activeAccount?.id).toBe(`${main.source.id}/0`)
  })
})

describe('Keyring — TON-native mnemonic (Tonkeeper)', () => {
  it('imports one TON account at the address Tonkeeper shows, and refuses it twice', async () => {
    const words = (await mnemonicNew(24)).join(' ')
    const direct = await WalletManagerTon.fromTonMnemonic(words)
    const expected = await (await direct.getAccount(0)).getAddress()
    direct.dispose()
    const { keyring } = await fresh({ ton: CHAINS.ton, evm: CHAINS.evm })
    const { account } = await keyring.importTonMnemonic(words)
    expect(account.addresses).toEqual({ ton: expected })
    expect(await keyring.withAccount(account.id, 'ton', (a) => a.getAddress())).toBe(expected)
    await expect(keyring.importTonMnemonic(words)).rejects.toMatchObject({ code: 'duplicate' })
    await expect(keyring.importTonMnemonic('one two')).rejects.toThrow(/24 words/)
  })
})

describe('Keyring — secrets never leave SecretStorage', () => {
  it('metadata holds no phrase, key or passphrase', async () => {
    const { keyring, storage } = await fresh()
    await keyring.importMnemonic(OTHER, { passphrase: 'hunter2-very-secret' })
    await keyring.importPrivateKey('evm', hex.encode(keyAt('evm')))
    const dump = JSON.stringify(storage.state)
    for (const needle of ['legal winner', 'hunter2-very-secret', hex.encode(keyAt('evm'))]) expect(dump).not.toContain(needle)
  })

  it('a missing secret is a named error, not a crash', async () => {
    const { keyring, secrets } = await fresh({ evm: CHAINS.evm })
    const { accounts, source } = await keyring.importMnemonic(ABANDON)
    secrets.map.delete(source.id)
    await expect(keyring.getAccount(accounts[0]!.id, 'evm')).rejects.toMatchObject({ code: 'secret-missing' })
  })
})

describe('Keyring — adopting a pre-keyring wallet and secret reads', () => {
  it('adopts an existing secret under its own id without writing or deleting it', async () => {
    const { keyring, secrets } = await fresh({ evm: CHAINS.evm })
    secrets.map.set('main', JSON.stringify({ type: 'mnemonic', mnemonic: ABANDON }))
    const { source, accounts } = await keyring.importMnemonic(ABANDON, { adoptId: 'main', label: 'Main' })
    expect(source.id).toBe('main')
    expect(accounts[0]).toMatchObject({ id: 'main/0', addresses: { evm: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' } })
    expect([...secrets.map.keys()]).toEqual(['main'])
    await expect(keyring.importMnemonic(OTHER, { adoptId: 'main' })).rejects.toMatchObject({ code: 'invalid-input' })
    expect(secrets.map.get('main')).toContain('abandon')
  })

  it('reads the secret once per operation (one biometric prompt), not once per index', async () => {
    const { keyring, secrets } = await fresh({ evm: CHAINS.evm })
    const { source } = await keyring.importMnemonic(ABANDON, { discover: { isUsed: async (_, i) => i < 4, maxIndex: 10 } })
    expect(secrets.reads).toBe(0) // import + discovery reuse the phrase in hand
    await keyring.addAccount(source.id)
    expect(secrets.reads).toBe(1)
    await keyring.discoverAccounts(source.id, { isUsed: async () => false, gapLimit: 3 })
    expect(secrets.reads).toBe(2)
  })
})
