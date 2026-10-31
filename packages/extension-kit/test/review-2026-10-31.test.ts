import { describe, expect, it } from 'vitest'
import { VAULT_MIN_SCRYPT, Vault, VaultError, isEnvelopeV2, memoryVaultStorage, type VaultEnvelopeV2 } from '../src/index.js'

// An empty vault proves a DEK with its DEK check box: after a rotation and the last secret deleted, the
// retired DEK cannot seal a new secret that the current DEK and the password would never open.
// Envelopes written before the DEK check stay readable and gain it on their next seal.

const PW = 'correct horse battery'
const enc = (t: string) => new TextEncoder().encode(t)
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof VaultError ? e.code : `other:${String(e)}`))
const vaultOn = (storage = memoryVaultStorage()) => ({ storage, vault: new Vault({ storage, scrypt: VAULT_MIN_SCRYPT }) })

describe('vault DEK check', () => {
  it('control: the retired DEK is refused while a secret remains', async () => {
    const { vault } = vaultOn()
    const first = await vault.create(PW)
    const old = Uint8Array.from(first)
    await vault.setSecret(first, 'seed', enc('words'))
    await vault.rotateVaultKey(PW)
    expect(await code(vault.setSecret(old, 'late', enc('x')))).toBe('locked')
  })

  it('rotate → delete last secret → setSecret(retired DEK) is refused; the current DEK still writes', async () => {
    const { storage, vault } = vaultOn()
    const first = await vault.create(PW)
    const old = Uint8Array.from(first)
    await vault.setSecret(first, 'seed', enc('words'))
    const current = await vault.rotateVaultKey(PW)
    await vault.deleteSecret('seed')
    expect(await code(vault.setSecret(old, 'late', enc('sealed under the retired key')))).toBe('locked')
    expect(Object.keys((storage.envelope as VaultEnvelopeV2).secrets)).toEqual([])
    await vault.setSecret(current, 'late', enc('sealed under the current key'))
    expect(dec(await vault.getSecret(await vault.unlock(PW), 'late'))).toBe('sealed under the current key')
  })

  it('a fresh empty vault refuses a foreign key and accepts its own', async () => {
    const { vault } = vaultOn()
    const dek = await vault.create(PW)
    expect(await code(vault.setSecret(crypto.getRandomValues(new Uint8Array(32)), 'seed', enc('x')))).toBe('locked')
    await vault.setSecret(dek, 'seed', enc('words'))
    expect(dec(await vault.getSecret(dek, 'seed'))).toBe('words')
  })

  it('changePassword and rotateVaultKey keep a DEK check bound to the DEK they write', async () => {
    const { storage, vault } = vaultOn()
    const dek = await vault.create(PW)
    const check0 = (storage.envelope as VaultEnvelopeV2).dekCheck
    expect(check0).toBeDefined()
    await vault.changePassword(PW, 'another long password')
    expect((storage.envelope as VaultEnvelopeV2).dekCheck).toBeDefined()
    await vault.setSecret(dek, 'seed', enc('words'))
    const next = await vault.rotateVaultKey('another long password')
    await vault.deleteSecret('seed')
    expect(await code(vault.setSecret(dek, 'a', enc('x')))).toBe('locked')
    await vault.setSecret(next, 'a', enc('x'))
  })

  it('a tampered DEK check is refused', async () => {
    const { storage, vault } = vaultOn()
    const dek = await vault.create(PW)
    const e = storage.envelope as VaultEnvelopeV2
    const other = vaultOn()
    await other.vault.create(PW)
    e.dekCheck = (other.storage.envelope as VaultEnvelopeV2).dekCheck!
    expect(await code(vault.setSecret(dek, 'seed', enc('x')))).toBe('locked')
  })

  it('an envelope from before the DEK check stays readable and gains the check on its next seal', async () => {
    const { storage, vault } = vaultOn()
    const dek = await vault.create(PW)
    await vault.setSecret(dek, 'seed', enc('words'))
    const old = structuredClone(storage.envelope) as VaultEnvelopeV2
    delete old.dekCheck
    const restored = vaultOn(memoryVaultStorage(old))
    expect(isEnvelopeV2(old)).toBe(true)
    const unlocked = await restored.vault.unlock(PW)
    expect(dec(await restored.vault.getSecret(unlocked, 'seed'))).toBe('words')
    // Without a check, the first secret proves the key.
    expect(await code(restored.vault.setSecret(crypto.getRandomValues(new Uint8Array(32)), 'b', enc('x')))).toBe('locked')
    await restored.vault.setSecret(unlocked, 'b', enc('y'))
    expect((restored.storage.envelope as VaultEnvelopeV2).dekCheck).toBeUndefined()
    await restored.vault.changePassword(PW, 'another long password')
    expect((restored.storage.envelope as VaultEnvelopeV2).dekCheck).toBeDefined()
    expect(dec(await restored.vault.getSecret(unlocked, 'b'))).toBe('y')
  })

  it('a malformed or oversized DEK check is not opened', async () => {
    const { storage, vault } = vaultOn()
    await vault.create(PW)
    const e = storage.envelope as VaultEnvelopeV2
    expect(isEnvelopeV2({ ...e, dekCheck: 'x' })).toBe(false)
    storage.envelope = { ...e, dekCheck: { iv: 'A'.repeat(40_000), data: 'A' } }
    expect(await code(vault.unlock(PW))).toBe('unsupported-envelope')
  })
})
