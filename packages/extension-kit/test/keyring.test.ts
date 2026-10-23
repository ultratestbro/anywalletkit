import { describe, expect, it } from 'vitest'
import { Keyring, type KeyringState } from '@forgewallet/keyring'
import { WalletManagerEvm } from '@forgewallet/wallet-evm'
import { Session, Vault, VaultError, caip2FromChainId, chainHex, chromeKeyringStorage, memoryAlarms, memorySessionStorage, memoryVaultStorage, vaultSecretStorage, type StorageAreaLike } from '../src/index.js'

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof VaultError ? e.code : `other:${String(e)}`))

function memoryArea(): StorageAreaLike & { items: Map<string, unknown> } {
  const items = new Map<string, unknown>()
  return {
    items,
    async get(keys) { const out: Record<string, unknown> = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (items.has(k)) out[k] = structuredClone(items.get(k)); return out },
    async set(o) { for (const [k, v] of Object.entries(o)) items.set(k, structuredClone(v)) },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) items.delete(k) },
  }
}

async function unlockedVault() {
  const vaultStorage = memoryVaultStorage()
  const vault = new Vault({ storage: vaultStorage })
  const session = new Session({ storage: memorySessionStorage(), alarms: memoryAlarms() })
  await session.unlock(await vault.create('pw-pw-pw-pw'))
  return { vault, vaultStorage, session }
}

describe('vaultSecretStorage', () => {
  it('seals and reads secrets through the session key; refuses when locked', async () => {
    const { vault, vaultStorage, session } = await unlockedVault()
    const secrets = vaultSecretStorage(vault, session)
    expect(await secrets.get('src1')).toBeNull()
    await secrets.set('src1', JSON.stringify({ type: 'mnemonic', mnemonic: ABANDON }))
    expect(JSON.stringify(vaultStorage.envelope)).not.toContain('abandon')
    expect(JSON.parse((await secrets.get('src1'))!)).toEqual({ type: 'mnemonic', mnemonic: ABANDON })
    await session.lock()
    expect(await code(secrets.get('src1'))).toBe('locked')
    expect(await code(secrets.set('src2', 'x'))).toBe('locked')
    // the ciphertext is still there for the next unlock
    await session.unlock(await vault.unlock('pw-pw-pw-pw'))
    expect(await secrets.get('src1')).not.toBeNull()
    await secrets.delete('src1')
    expect(await secrets.get('src1')).toBeNull()
  })
})

describe('chromeKeyringStorage', () => {
  it('round-trips the keyring state as plain JSON under one key', async () => {
    const area = memoryArea()
    const storage = chromeKeyringStorage(area)
    expect(await storage.load()).toBeNull()
    const state: KeyringState = { version: 1, sources: [], accounts: [], activeAccountId: null }
    await storage.save(state)
    expect([...area.items.keys()]).toEqual(['forgewallet.keyring.v1'])
    expect(await storage.load()).toEqual(state)
  })
})

describe('Keyring over the vault', () => {
  it('creates a seed, derives accounts and signs with the secret sealed in the vault', async () => {
    const { vault, vaultStorage, session } = await unlockedVault()
    const area = memoryArea()
    const open = () => Keyring.load({ storage: chromeKeyringStorage(area), secrets: vaultSecretStorage(vault, session), chains: { evm: { Manager: WalletManagerEvm, config: {} } } })
    const keyring = await open()
    const { source, account, mnemonic } = await keyring.createMnemonic({ words: 12 })
    expect(mnemonic.split(' ')).toHaveLength(12)
    expect(account.addresses.evm).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(await vault.listSecretIds()).toEqual([source.id])
    // Two words with their space: a single word can be a JSON key by chance (BIP-39 has "label", "account", "index").
    const probe = mnemonic.split(' ').slice(0, 2).join(' ')
    expect(JSON.stringify(vaultStorage.envelope)).not.toContain(probe)
    // metadata holds addresses only
    expect(JSON.stringify([...area.items.values()])).not.toContain(probe)
    expect(JSON.stringify([...area.items.values()])).not.toContain(mnemonic)

    const second = await keyring.addAccount(source.id)
    expect(second.index).toBe(1)
    const imported = await keyring.importMnemonic(ABANDON, { label: 'Test' })
    expect(imported.accounts[0]!.addresses.evm).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')

    // a fresh worker (new Keyring over the same storage) still reads the sealed secret
    const again = await open()
    const sig = await again.withAccount(imported.accounts[0]!.id, 'evm', (a) => a.sign('hello'))
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)

    await session.lock()
    await expect(again.withAccount(imported.accounts[0]!.id, 'evm', (a) => a.getAddress())).rejects.toMatchObject({ code: 'locked' })
    // listing never touches a secret, so it works locked
    expect(again.listAccounts()).toHaveLength(3)
  })
})

describe('networks helpers', () => {
  it('chain ids', () => {
    expect(chainHex('eip155:1')).toBe('0x1')
    expect(chainHex('eip155:8453')).toBe('0x2105')
    expect(caip2FromChainId('0x2105')).toBe('eip155:8453')
    expect(caip2FromChainId('1')).toBe('eip155:1')
    expect(caip2FromChainId(137)).toBe('eip155:137')
    expect(caip2FromChainId('0x')).toBeNull()
    expect(caip2FromChainId('-1')).toBeNull()
    expect(caip2FromChainId(0)).toBeNull()
    expect(caip2FromChainId({})).toBeNull()
  })
})
