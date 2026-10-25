import { describe, expect, it } from 'vitest'
import { Keyring, type KeyringStorage } from '@anywalletkit/keyring'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import {
  Session, VAULT_LIMITS, VAULT_MIN_SCRYPT, Vault, VaultError, memoryAlarms, memorySessionStorage, memoryVaultStorage, vaultSecretStorage,
  type VaultEnvelopeV1, type VaultEnvelopeV2,
} from '../src/index.js'

// Audit 2026-10-25, findings 6 and 9: parallel writes to the envelope lost a secret (last write
// wins), and an envelope's KDF cost and size had no upper bound (a crafted vault hangs or crashes
// the worker on unlock).

const PW = 'pw-pw-pw-pw'
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof VaultError ? e.code : `other:${String(e)}`))
const v2 = (storage = memoryVaultStorage()) => new Vault({ storage, scrypt: VAULT_MIN_SCRYPT })

describe('Vault: parallel writes keep every change', () => {
  it('two setSecret at once → both secrets after a reload', async () => {
    const storage = memoryVaultStorage()
    const dek = await v2(storage).create(PW)
    const vault = v2(storage)
    await Promise.all([vault.setSecret(dek, 'a', enc('secret a')), vault.setSecret(dek, 'b', enc('secret b'))])
    const reloaded = v2(storage)
    expect((await reloaded.listSecretIds()).sort()).toEqual(['a', 'b'])
    expect(dec(await reloaded.getSecret(dek, 'a'))).toBe('secret a')
    expect(dec(await reloaded.getSecret(dek, 'b'))).toBe('secret b')
  })

  it('setSecret racing deleteSecret, addPasskey, removePasskey and changePassword → nothing lost', async () => {
    const storage = memoryVaultStorage()
    const dek = await v2(storage).create(PW)
    const vault = v2(storage)
    await vault.setSecret(dek, 'old', enc('to delete'))
    // a secret that stays: addPasskey needs one to prove the DEK, and 'old' may be gone when it runs
    await vault.setSecret(dek, 'keep', enc('kept'))
    const prf = () => Uint8Array.from({ length: 32 }, (_, i) => i)
    await Promise.all([
      vault.setSecret(dek, 'a', enc('secret a')),
      vault.deleteSecret('old'),
      vault.addPasskey(Uint8Array.from(dek), { id: 'cred-1', prf: prf(), label: 'Laptop' }),
      vault.setSecret(dek, 'b', enc('secret b')),
      vault.changePassword(PW, 'new-pw-new-pw'),
      vault.setSecret(dek, 'c', enc('secret c')),
    ])
    const reloaded = v2(storage)
    expect((await reloaded.listSecretIds()).sort()).toEqual(['a', 'b', 'c', 'keep'])
    expect((await reloaded.listPasskeys()).map((p) => p.id)).toEqual(['cred-1'])
    const again = await reloaded.unlock('new-pw-new-pw')
    expect(dec(await reloaded.getSecret(again, 'c'))).toBe('secret c')
    expect(Array.from(await reloaded.unlockWithPasskey('cred-1', prf()))).toEqual(Array.from(again))
  })

  it('a v1 → v2 upgrade on unlock does not drop a secret written meanwhile', async () => {
    const storage = memoryVaultStorage()
    const dek = await new Vault({ storage, kdf: 'pbkdf2' }).create(PW)
    const vault = v2(storage)
    await Promise.all([vault.unlock(PW), vault.setSecret(dek, 'late', enc('late secret'))])
    const reloaded = v2(storage)
    expect(storage.envelope?.v).toBe(2)
    expect(dec(await reloaded.getSecret(dek, 'late'))).toBe('late secret')
  })

  it('two parallel imports through the keyring → both accounts sign after a reload', async () => {
    const storage = memoryVaultStorage()
    const vault = v2(storage)
    const session = new Session({ storage: memorySessionStorage(), alarms: memoryAlarms() })
    await session.unlock(await vault.create(PW))
    let state: unknown = null
    const meta: KeyringStorage = { load: async () => structuredClone(state) as never, save: async (s) => { state = structuredClone(s) } }
    const chains = { evm: { Manager: WalletManagerEvm, config: { chainId: 1 } } }
    // Two keyrings over one vault: the vault is the only thing they share.
    const [k1, k2] = await Promise.all([Keyring.load({ storage: meta, secrets: vaultSecretStorage(vault, session), chains }), Keyring.load({ storage: { load: async () => null, save: async () => undefined }, secrets: vaultSecretStorage(vault, session), chains })])
    const [a, b] = await Promise.all([
      k1.importMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
      k2.importMnemonic('legal winner thank year wave sausage worth useful legal winner thank yellow'),
    ])
    const reopened = vaultSecretStorage(v2(storage), session)
    expect(await reopened.get(a.source.id)).not.toBeNull()
    expect(await reopened.get(b.source.id)).not.toBeNull()
  })
})

describe('Vault: KDF cost and envelope size are bounded before any KDF runs', () => {
  async function v2Envelope(): Promise<VaultEnvelopeV2> {
    const storage = memoryVaultStorage()
    await v2(storage).create(PW)
    return structuredClone(storage.envelope) as VaultEnvelopeV2
  }
  const timed = async (p: Promise<unknown>) => { const t = Date.now(); const c = await code(p); return { c, ms: Date.now() - t } }

  it('a scrypt envelope above N / r / p limits is refused at once', async () => {
    for (const kdf of [{ N: 2 ** 30 }, { N: 2 ** 21 }, { r: 1024 }, { r: 17 }, { p: 64 }, { p: 5 }]) {
      const e = await v2Envelope()
      const { c, ms } = await timed(v2(memoryVaultStorage({ ...e, kdf: { ...e.kdf, ...kdf } })).unlock(PW))
      expect(c, JSON.stringify(kdf)).toBe('unsupported-envelope')
      expect(ms).toBeLessThan(200)
    }
    expect(VAULT_LIMITS.scrypt).toEqual({ N: 2 ** 20, r: 16, p: 4 })
  })

  it('a PBKDF2 envelope above the iteration limit is refused at once', async () => {
    const storage = memoryVaultStorage()
    await new Vault({ storage, kdf: 'pbkdf2' }).create(PW)
    const e = structuredClone(storage.envelope) as VaultEnvelopeV1
    // 100M runs for minutes in a service worker; 10^10 is past what WebCrypto takes at all
    for (const iterations of [100_000_000, 10_000_000_000]) {
      const { c, ms } = await timed(new Vault({ storage: memoryVaultStorage({ ...e, kdf: { ...e.kdf, iterations } }), kdf: 'pbkdf2' }).unlock(PW))
      expect(c, String(iterations)).toBe('unsupported-envelope')
      expect(ms).toBeLessThan(200)
    }
    expect(VAULT_LIMITS.iterations).toBe(5_000_000)
  })

  it('options above the limits are refused by the constructor', () => {
    expect(() => new Vault({ storage: memoryVaultStorage(), scrypt: { N: 2 ** 21, r: 8, p: 1 } })).toThrow(VaultError)
    expect(() => new Vault({ storage: memoryVaultStorage(), scrypt: { N: 2 ** 14, r: 32, p: 1 } })).toThrow(VaultError)
    expect(() => new Vault({ storage: memoryVaultStorage(), kdf: 'pbkdf2', iterations: 6_000_000 })).toThrow(VaultError)
  })

  it('too many secrets, a huge box or a huge envelope is refused; setSecret stops at the cap', async () => {
    const e = await v2Envelope()
    const box = { iv: 'AAAAAAAAAAAAAAAA', data: 'AAAA' }
    const many = Object.fromEntries(Array.from({ length: VAULT_LIMITS.secrets + 1 }, (_, i) => [`s${i}`, box]))
    expect(await code(v2(memoryVaultStorage({ ...e, secrets: many })).unlock(PW))).toBe('unsupported-envelope')
    expect(await code(v2(memoryVaultStorage({ ...e, secrets: { big: { iv: box.iv, data: 'A'.repeat(VAULT_LIMITS.boxChars + 4) } } })).unlock(PW))).toBe('unsupported-envelope')
    expect(await code(v2(memoryVaultStorage({ ...e, kdf: { ...e.kdf, salt: 'A'.repeat(VAULT_LIMITS.envelopeChars) } })).unlock(PW))).toBe('unsupported-envelope')
    const passkeys = Array.from({ length: VAULT_LIMITS.passkeys + 1 }, (_, i) => ({ id: `p${i}`, label: 'x', createdAt: 0, dek: box }))
    expect(await code(v2(memoryVaultStorage({ ...e, passkeys })).unlock(PW))).toBe('unsupported-envelope')

    const storage = memoryVaultStorage()
    const vault = v2(storage)
    const dek = await vault.create(PW)
    expect(await code(vault.setSecret(dek, 'huge', new Uint8Array(VAULT_LIMITS.secretBytes + 1)))).toBe('invalid-input')
    await vault.setSecret(dek, 'one', enc('x'))
    const full = structuredClone(storage.envelope) as VaultEnvelopeV2
    full.secrets = Object.fromEntries(Array.from({ length: VAULT_LIMITS.secrets }, (_, i) => [`s${i}`, full.secrets.one!]))
    storage.envelope = full // at the cap
    expect(await code(vault.setSecret(dek, 'one-more', enc('x')))).toBe('invalid-input')
    await expect(vault.setSecret(dek, 's0', enc('overwrite is fine'))).resolves.toBeUndefined()
  })
})
