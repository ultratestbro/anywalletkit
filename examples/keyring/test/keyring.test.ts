import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@forgewallet/conformance'
import { UserRejectedError } from '@forgewallet/core'
import { KeyringError } from '@forgewallet/keyring'
import {
  createWallet, importKey, manageAccounts, openKeyring, plainMetadata, restoreWallet, revealSecret, removeWallet, secureSecrets, signMessage,
  type PlainStoreLike, type SecureStoreLike,
} from '../src/keyring.ts'

const PHRASE = derivationVectors.seeds['bip39-abandon-12']!
const golden = (chain: 'evm' | 'solana' | 'ton' | 'tron', i = 0) => derivationVectors.vectors[chain]['bip39-abandon-12']!.accounts[i]!

type Opts = { requireAuthentication: boolean }
function fakeSecureStore() {
  const items = new Map<string, string>()
  const calls: Opts[] = []
  const store: SecureStoreLike<Opts> = {
    getItemAsync: async (k, o) => { calls.push(o!); return items.get(k) ?? null },
    setItemAsync: async (k, v, o) => { calls.push(o!); items.set(k, v) },
    deleteItemAsync: async (k, o) => { calls.push(o!); items.delete(k) },
  }
  return { store, items, calls }
}
function fakePlainStore() {
  const items = new Map<string, string>()
  const store: PlainStoreLike = { getItem: async (k) => items.get(k) ?? null, setItem: async (k, v) => { items.set(k, v) } }
  return { store, items }
}
async function setup() {
  const secure = fakeSecureStore()
  const plain = fakePlainStore()
  const keyring = await openKeyring(plainMetadata(plain.store), secureSecrets(secure.store, { requireAuthentication: true }))
  return { keyring, secure, plain }
}

describe('Keyring guide (docs) — offline', () => {
  it('restores a seed: account 0 on every chain is the address other wallets show; discovery adds used accounts', async () => {
    const { keyring } = await setup()
    const used = new Set([golden('evm', 1).address])
    const accounts = await restoreWallet(keyring, PHRASE, async (a) => used.has(a.evm!))
    expect(accounts.map((a) => a.index)).toEqual([0, 1])
    expect(accounts[0]!.addresses).toEqual({ evm: golden('evm').address, solana: golden('solana').address, ton: golden('ton').address, tron: golden('tron').address })
    await expect(restoreWallet(keyring, PHRASE, async () => false)).rejects.toMatchObject({ code: 'duplicate' })
  })

  it('secrets go only to secure storage, with its protection options; metadata holds no words', async () => {
    const { keyring, secure, plain } = await setup()
    const { mnemonic } = await createWallet(keyring)
    expect(mnemonic.split(' ')).toHaveLength(12)
    expect(secure.items.size).toBe(1)
    expect([...secure.items.keys()][0]).toMatch(/^awk\.secret\.[0-9a-f]+$/)
    expect(secure.calls.every((o) => o.requireAuthentication)).toBe(true)
    const metadata = plain.items.get('awk.keyring')!
    // Adjacent word pairs, not single words: metadata keys like "name", "index", "label" are BIP-39 words too.
    const words = mnemonic.split(' ')
    expect(metadata).not.toContain(mnemonic)
    for (let i = 0; i + 1 < words.length; i++) expect(metadata).not.toContain(`${words[i]} ${words[i + 1]}`)
  })

  it('listing and managing accounts reads no secret', async () => {
    const { keyring, secure } = await setup()
    const [first] = await restoreWallet(keyring, PHRASE, async () => false)
    const reads = () => secure.calls.length
    const before = reads()
    expect(keyring.listAccounts()).toHaveLength(1)
    expect(reads()).toBe(before)
    const list = await manageAccounts(keyring, first!.sourceId) // addAccount reads the secret once
    expect(list.map((a) => a.name)).toEqual(['Account 1', 'Long-term'])
    expect(keyring.state.activeAccountId).toBe(list[1]!.id)
  })

  it('signs through the policies; a refusal stops before the key signs', async () => {
    const { keyring } = await setup()
    const [first] = await restoreWallet(keyring, PHRASE, async () => false)
    const sig = await signMessage(keyring, first!.id, { confirm: async () => true }, derivationVectors.message)
    expect(sig).toBe(golden('evm').signMessage)
    await expect(signMessage(keyring, first!.id, { confirm: async () => false }, 'no')).rejects.toBeInstanceOf(UserRejectedError)
  })

  it('imports a private key after showing its address; the backup screen needs authentication', async () => {
    const { keyring, secure } = await setup()
    const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' // hardhat account #1, public test key
    const shown: string[] = []
    const imported = await importKey(keyring, 'evm', key, async (a) => { shown.push(a); return true })
    expect(shown).toEqual(['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'])
    expect(imported!.account.addresses.evm).toBe(shown[0])
    await expect(revealSecret(keyring, imported!.source.id, async () => false)).rejects.toThrow(/Not authenticated/)
    expect((await revealSecret(keyring, imported!.source.id, async () => true)).type).toBe('privateKey')
    await removeWallet(keyring, imported!.source.id)
    expect(secure.items.size).toBe(0)
    await expect(importKey(keyring, 'evm', 'not a key', async () => true)).rejects.toBeInstanceOf(KeyringError)
  })
})
