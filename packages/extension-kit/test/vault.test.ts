import { describe, expect, it } from 'vitest'
import { VAULT_MIN_ITERATIONS, VAULT_MIN_SCRYPT, Vault, VaultError, chromeLocalVaultStorage, fromBase64Url, isEnvelopeV1, isEnvelopeV2, memoryVaultStorage, toBase64Url, type StorageAreaLike, type VaultEnvelopeV1, type VaultEnvelopeV2 } from '../src/index.js'

const SEED = new TextEncoder().encode('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof VaultError ? e.code : `other:${String(e)}`))
/** Tests run scrypt at the floor (16 MiB) — the default 128 MiB is for the real vault. */
const SCRYPT = VAULT_MIN_SCRYPT
const v2 = (storage = memoryVaultStorage(), extra: Record<string, unknown> = {}) => new Vault({ storage, scrypt: SCRYPT, ...extra })
const v1 = (storage = memoryVaultStorage()) => new Vault({ storage, kdf: 'pbkdf2' })

describe('Vault', () => {
  it('creates a v1 envelope with PBKDF2-SHA256 ≥ 600k and AES-GCM boxes when asked; refuses weaker settings', async () => {
    const storage = memoryVaultStorage()
    const vault = v1(storage)
    const dek = await vault.create('correct horse')
    expect(dek).toHaveLength(32)
    const e = storage.envelope as VaultEnvelopeV1
    expect(isEnvelopeV1(e)).toBe(true)
    expect(e.kdf).toMatchObject({ name: 'PBKDF2-SHA256', iterations: VAULT_MIN_ITERATIONS })
    expect(atob(e.kdf.salt)).toHaveLength(32)
    expect(atob(e.dek.iv)).toHaveLength(12)
    expect(atob(e.dek.data)).toHaveLength(32 + 16) // DEK ‖ GCM tag
    expect(e.secrets).toEqual({})
    expect(() => new Vault({ storage, iterations: 100_000 })).toThrow(VaultError)
    expect(() => new Vault({ storage, scrypt: { N: 1 << 10, r: 8, p: 1 } })).toThrow(VaultError)
    expect(() => new Vault({ storage, scrypt: { N: (1 << 14) + 1, r: 8, p: 1 } })).toThrow(VaultError)
    expect(await code(vault.create(''))).toBe('invalid-input')
  })

  it('refuses passwords under 8 characters at create / changePassword (SDK-142 L1); unlock takes what opens the vault', async () => {
    const storage = memoryVaultStorage()
    const vault = v2(storage)
    expect(await code(vault.create('1234567'))).toBe('invalid-input')
    expect(await code(vault.create('пароль7'))).toBe('invalid-input') // 7 code points, 14 bytes
    expect(storage.envelope).toBeNull()
    await vault.create('12345678')
    expect(await code(vault.changePassword('12345678', 'short'))).toBe('invalid-input')
    expect(await code(vault.unlock('12345678'))).toBe('resolved')
  })

  it('an envelope whose KDF block was edited on disk does not open (AAD) and a lowered count is refused outright (SDK-142 L2)', async () => {
    const storage = memoryVaultStorage()
    const vault = v1(storage)
    await vault.create('pw-pw-pw-pw')
    const e = structuredClone(storage.envelope as VaultEnvelopeV1)
    storage.envelope = { ...e, kdf: { ...e.kdf, iterations: 1_000 } }
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('weak-kdf')
    storage.envelope = { ...e, kdf: { ...e.kdf, iterations: e.kdf.iterations + 1 } }
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('wrong-password')
    const salt = Uint8Array.from(atob(e.kdf.salt), (c) => c.charCodeAt(0))
    salt[0] = salt[0]! ^ 1
    storage.envelope = { ...e, kdf: { ...e.kdf, salt: btoa(String.fromCharCode(...salt)) } }
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('wrong-password')
    storage.envelope = { ...e, kdf: { ...e.kdf, iterations: 600_000.5 } }
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('unsupported-envelope')
    storage.envelope = e
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('resolved')
  })

  it('v2: scrypt envelope; edited N / salt fail to open; N under the floor or not a power of two is refused; progress is reported', async () => {
    const storage = memoryVaultStorage()
    const progress: number[] = []
    const vault = v2(storage, { onProgress: (f: number) => progress.push(f) })
    const dek = await vault.create('pw-pw-pw-pw')
    const e = structuredClone(storage.envelope as VaultEnvelopeV2)
    expect(isEnvelopeV2(e)).toBe(true)
    expect(e.kdf).toMatchObject({ name: 'scrypt', N: SCRYPT.N, r: 8, p: 1 })
    expect(atob(e.kdf.salt)).toHaveLength(32)
    expect(e.passkeys).toEqual([])
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe(1)
    expect(await vault.kdfInfo()).toEqual({ version: 2, name: 'scrypt', summary: 'scrypt N=2^14 r=8 p=1' })
    expect(Array.from(await vault.unlock('pw-pw-pw-pw'))).toEqual(Array.from(dek))
    expect(await code(vault.unlock('pw-pw-pw-pX'))).toBe('wrong-password')
    storage.envelope = { ...e, kdf: { ...e.kdf, N: SCRYPT.N * 2 } }
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('wrong-password')
    storage.envelope = { ...e, kdf: { ...e.kdf, N: 1 << 10 } }
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('weak-kdf')
    storage.envelope = { ...e, kdf: { ...e.kdf, N: SCRYPT.N + 1 } }
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('weak-kdf')
    storage.envelope = { ...e, kdf: { ...e.kdf, r: 4 } }
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('weak-kdf')
    const salt = Uint8Array.from(atob(e.kdf.salt), (c) => c.charCodeAt(0))
    salt[5] = salt[5]! ^ 1
    storage.envelope = { ...e, kdf: { ...e.kdf, salt: btoa(String.fromCharCode(...salt)) } }
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('wrong-password')
    storage.envelope = { ...e, passkeys: 'nope' as never }
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('unsupported-envelope')
  })

  it('a v1 vault opens with its password and comes out as v2 with the same secrets, DEK and createdAt', async () => {
    const storage = memoryVaultStorage()
    const old = v1(storage)
    const dek = await old.create('pw-pw-pw-pw')
    await old.setSecret(dek, 'main', SEED)
    const before = storage.envelope as VaultEnvelopeV1
    const vault = v2(storage)
    expect(await vault.kdfInfo()).toMatchObject({ version: 1 })
    const again = await vault.unlock('pw-pw-pw-pw')
    expect(Array.from(again)).toEqual(Array.from(dek))
    const after = storage.envelope as VaultEnvelopeV2
    expect(isEnvelopeV2(after)).toBe(true)
    expect(after.secrets).toEqual(before.secrets) // untouched: the secret AAD does not carry the envelope version
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.upgradedAt).toBeTypeOf('number')
    expect(Array.from((await vault.getSecret(again, 'main'))!)).toEqual(Array.from(SEED))
    expect(Array.from(await vault.unlock('pw-pw-pw-pw'))).toEqual(Array.from(dek))
    // a wrong password on a v1 vault leaves it v1
    const s2 = memoryVaultStorage()
    await v1(s2).create('pw-pw-pw-pw')
    expect(await code(v2(s2).unlock('nope-nope-nope'))).toBe('wrong-password')
    expect(isEnvelopeV1(s2.envelope)).toBe(true)
    // a build that insists on pbkdf2 does not upgrade
    const s3 = memoryVaultStorage()
    await v1(s3).create('pw-pw-pw-pw')
    await v1(s3).unlock('pw-pw-pw-pw')
    expect(isEnvelopeV1(s3.envelope)).toBe(true)
  })

  it('a passkey cannot be added to an empty vault: with no secret to open, any 32 bytes would pass as the DEK', async () => {
    // Audit 2026-10-25 (post-release), L5: _requireDek returned early on an empty vault, so a wrong key
    // was sealed under the passkey and every later unlock by passkey handed out that wrong key.
    const storage = memoryVaultStorage()
    const vault = v2(storage)
    const dek = await vault.create('pw-pw-pw-pw')
    const id = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
    const prf = () => crypto.getRandomValues(new Uint8Array(32))
    expect(await code(vault.addPasskey(new Uint8Array(32).fill(7), { id, prf: prf(), label: 'x' }))).toBe('invalid-input')
    expect(await code(vault.addPasskey(dek, { id, prf: prf(), label: 'x' }))).toBe('invalid-input')
    expect(await vault.listPasskeys()).toEqual([])
    await vault.setSecret(dek, 'main', SEED)
    await vault.addPasskey(dek, { id, prf: prf(), label: 'x' })
    expect(await vault.listPasskeys()).toHaveLength(1)
  })

  it('passkeys: the DEK sealed under HKDF(PRF, credential id); unlock by PRF; wrong PRF / unknown id refused; remove; survives changePassword; needs the vault\'s own DEK', async () => {
    const storage = memoryVaultStorage()
    const vault = v2(storage)
    const dek = await vault.create('pw-pw-pw-pw')
    await vault.setSecret(dek, 'main', SEED)
    const id = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
    const prf = crypto.getRandomValues(new Uint8Array(32))
    const prfCopy = Uint8Array.from(prf)
    expect(await code(vault.addPasskey(new Uint8Array(32), { id, prf: Uint8Array.from(prf), label: 'Touch ID' }))).toBe('locked') // not the vault's DEK
    expect(await code(vault.addPasskey(dek, { id, prf: new Uint8Array(16), label: 'x' }))).toBe('invalid-input')
    await vault.addPasskey(dek, { id, prf, label: 'Touch ID', publicKey: 'AAAA', alg: -7 })
    expect(Array.from(prf)).toEqual(Array(32).fill(0)) // zeroized
    expect(await vault.listPasskeys()).toEqual([{ id, label: 'Touch ID', createdAt: expect.any(Number), canVerify: true }])
    expect(await vault.passkeyPublicKey(id)).toEqual({ publicKey: 'AAAA', alg: -7 })
    expect(await code(vault.addPasskey(dek, { id, prf: Uint8Array.from(prfCopy), label: 'again' }))).toBe('exists')
    const viaPasskey = await vault.unlockWithPasskey(id, Uint8Array.from(prfCopy))
    expect(Array.from(viaPasskey)).toEqual(Array.from(dek))
    expect(Array.from((await vault.getSecret(viaPasskey, 'main'))!)).toEqual(Array.from(SEED))
    const wrong = Uint8Array.from(prfCopy); wrong[0] = wrong[0]! ^ 1
    expect(await code(vault.unlockWithPasskey(id, wrong))).toBe('wrong-password')
    expect(await code(vault.unlockWithPasskey(toBase64Url(new Uint8Array(16)), Uint8Array.from(prfCopy)))).toBe('missing')
    expect(await code(vault.unlockWithPasskey(id, new Uint8Array(8)))).toBe('invalid-input')
    // the passkey box is bound to its id: moving it under another id does not open
    const e = storage.envelope as VaultEnvelopeV2
    const otherId = toBase64Url(new Uint8Array(16).fill(9))
    storage.envelope = { ...e, passkeys: [{ ...e.passkeys[0]!, id: otherId }] }
    expect(await code(vault.unlockWithPasskey(otherId, Uint8Array.from(prfCopy)))).toBe('wrong-password')
    storage.envelope = e
    // password change keeps the passkey; the envelope never holds the PRF or the DEK in clear
    await vault.changePassword('pw-pw-pw-pw', 'new-new-new')
    expect((await vault.listPasskeys()).map((p) => p.id)).toEqual([id])
    expect(Array.from(await vault.unlockWithPasskey(id, Uint8Array.from(prfCopy)))).toEqual(Array.from(dek))
    const json = JSON.stringify(storage.envelope)
    expect(json).not.toContain(btoa(String.fromCharCode(...prfCopy)))
    expect(json).not.toContain(btoa(String.fromCharCode(...dek)))
    await vault.removePasskey(id)
    expect(await vault.listPasskeys()).toEqual([])
    expect(await code(vault.unlockWithPasskey(id, Uint8Array.from(prfCopy)))).toBe('missing')
    // a v1 vault must be upgraded (unlocked) before it can take a passkey
    const s1 = memoryVaultStorage()
    const d1 = await v1(s1).create('pw-pw-pw-pw')
    expect(await code(v2(s1).addPasskey(d1, { id, prf: Uint8Array.from(prfCopy), label: 'x' }))).toBe('unsupported-envelope')
    expect(fromBase64Url(toBase64Url(prfCopy))).toEqual(prfCopy)
  })

  it('never overwrites an existing vault', async () => {
    const storage = memoryVaultStorage()
    const vault = v2(storage)
    await vault.create('aaaaaaaa')
    const before = structuredClone(storage.envelope)
    expect(await code(vault.create('bbbbbbbb'))).toBe('exists')
    expect(storage.envelope).toEqual(before)
  })

  it('unlocks with the right password only; stores and reads secrets under the DEK', async () => {
    const storage = memoryVaultStorage()
    const vault = v2(storage)
    const dek = await vault.create('pw-pw-pw-pw')
    await vault.setSecret(dek, 'main', SEED)
    expect(await vault.listSecretIds()).toEqual(['main'])
    // the envelope holds ciphertext only
    expect(JSON.stringify(storage.envelope)).not.toContain('abandon')

    const again = await vault.unlock('pw-pw-pw-pw')
    expect(Array.from(again)).toEqual(Array.from(dek))
    expect(Array.from((await vault.getSecret(again, 'main'))!)).toEqual(Array.from(SEED))
    expect(await vault.getSecret(again, 'nope')).toBeNull()
    expect(await code(vault.unlock('PW'))).toBe('wrong-password')
    expect(await code(v2().unlock('pw'))).toBe('missing')
  })

  it('binds each secret to its id (AAD) and detects tampering', async () => {
    const storage = memoryVaultStorage()
    const vault = v2(storage)
    const dek = await vault.create('pw-pw-pw-pw')
    await vault.setSecret(dek, 'a', SEED)
    await vault.setSecret(dek, 'b', new Uint8Array([1, 2, 3]))
    // swap the two boxes inside the envelope
    const e = storage.envelope!
    const swapped = { ...e, secrets: { a: e.secrets.b!, b: e.secrets.a! } }
    storage.envelope = swapped
    expect(await code(vault.getSecret(dek, 'a'))).toBe('locked')
    // flip one ciphertext byte of the wrapped DEK
    const bytes = Uint8Array.from(atob(e.dek.data), (c) => c.charCodeAt(0))
    bytes[0] = bytes[0]! ^ 1
    storage.envelope = { ...e, dek: { ...e.dek, data: btoa(String.fromCharCode(...bytes)) } }
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('wrong-password')
    // a wrong DEK length is refused before touching WebCrypto
    expect(await code(vault.getSecret(new Uint8Array(16), 'a'))).toBe('invalid-input')
  })

  it('changes the password without re-encrypting the secrets; deletes and destroys', async () => {
    const storage = memoryVaultStorage()
    const vault = v2(storage)
    const dek = await vault.create('old-old-old')
    await vault.setSecret(dek, 'main', SEED)
    const boxBefore = storage.envelope!.secrets.main
    await vault.changePassword('old-old-old', 'new-new-new')
    expect(storage.envelope!.secrets.main).toEqual(boxBefore)
    expect(await code(vault.unlock('old-old-old'))).toBe('wrong-password')
    const dek2 = await vault.unlock('new-new-new')
    expect(Array.from((await vault.getSecret(dek2, 'main'))!)).toEqual(Array.from(SEED))
    expect(await code(vault.changePassword('wrong-wrong', 'xxxxxxxx'))).toBe('wrong-password')
    await vault.deleteSecret('main')
    await vault.deleteSecret('main') // idempotent
    expect(await vault.listSecretIds()).toEqual([])
    await vault.destroy()
    expect(await vault.exists()).toBe(false)
  })

  it('refuses an envelope version it does not know', async () => {
    const storage = memoryVaultStorage()
    const vault = v2(storage)
    await vault.create('pw-pw-pw-pw')
    storage.envelope = { ...storage.envelope!, v: 3 } as never
    expect(await code(vault.unlock('pw-pw-pw-pw'))).toBe('unsupported-envelope')
  })

  it('works over a chrome.storage.local-shaped area', async () => {
    const items = new Map<string, unknown>()
    const area: StorageAreaLike = {
      async get(keys) { const out: Record<string, unknown> = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (items.has(k)) out[k] = structuredClone(items.get(k)); return out },
      async set(o) { for (const [k, v] of Object.entries(o)) items.set(k, structuredClone(v)) },
      async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) items.delete(k) },
    }
    const vault = new Vault({ storage: chromeLocalVaultStorage(area) })
    expect(await vault.exists()).toBe(false)
    const dek = await vault.create('pw-pw-pw-pw')
    await vault.setSecret(dek, 'main', SEED)
    expect([...items.keys()]).toEqual(['forgewallet.vault.v1'])
    expect(Array.from((await new Vault({ storage: chromeLocalVaultStorage(area) }).getSecret(await vault.unlock('pw-pw-pw-pw'), 'main'))!)).toEqual(Array.from(SEED))
  })
})
