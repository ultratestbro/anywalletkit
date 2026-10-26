import { describe, expect, it } from 'vitest'
import { VAULT_MIN_SCRYPT, Vault, memoryVaultStorage, toBase64Url } from '../src/index.js'

// Audit 2026-10-25 round 3, L1 (codec part): WebCrypto gets a fresh ArrayBuffer copy of every input
// (`toArrayBuffer`). The copies of the password, the scrypt output (KEK), the DEK, the passkey PRF
// output and every sealed plaintext (the phrase) were left in memory after the call. WebCrypto copies
// its input when called, so the wallet's copy can be wiped right after.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

/** globalThis.crypto that remembers the buffers handed to it, by role. */
function recordingCrypto() {
  const seen: { role: string; buffer: ArrayBuffer; first: Uint8Array }[] = []
  const keep = (role: string, data: unknown) => {
    if (data instanceof ArrayBuffer) seen.push({ role, buffer: data, first: new Uint8Array(data.slice(0)) })
  }
  const subtle = globalThis.crypto.subtle
  const proxy = {
    importKey: (format: string, keyData: unknown, ...rest: unknown[]) => { keep(`importKey:${typeof rest[0] === 'string' ? rest[0] : (rest[0] as { name: string }).name}`, keyData); return (subtle.importKey as (...a: unknown[]) => unknown)(format, keyData, ...rest) },
    encrypt: (alg: unknown, key: unknown, data: unknown) => { keep('encrypt:plaintext', data); return (subtle.encrypt as (...a: unknown[]) => unknown)(alg, key, data) },
    decrypt: (...a: unknown[]) => (subtle.decrypt as (...a: unknown[]) => unknown)(...a),
    deriveKey: (...a: unknown[]) => (subtle.deriveKey as (...a: unknown[]) => unknown)(...a),
    digest: (...a: unknown[]) => (subtle.digest as (...a: unknown[]) => unknown)(...a),
  }
  const c = { subtle: proxy, getRandomValues: <T extends ArrayBufferView>(a: T) => globalThis.crypto.getRandomValues(a as never) as T, randomUUID: () => globalThis.crypto.randomUUID() } as unknown as Crypto
  /** Secret copies (anything but the AES-GCM IV / AAD / ciphertext) that still hold their bytes. */
  const leftovers = () => seen.filter((s) => s.first.some((b) => b !== 0) && new Uint8Array(s.buffer).some((b) => b !== 0)).map((s) => s.role)
  return { crypto: c, seen, leftovers }
}

describe('Vault wipes the WebCrypto copies of its secrets', () => {
  it('scrypt vault: password→KEK, DEK and the sealed phrase leave no copy behind; the vault still opens', async () => {
    const rec = recordingCrypto()
    const vault = new Vault({ storage: memoryVaultStorage(), scrypt: VAULT_MIN_SCRYPT, crypto: rec.crypto })
    const dek = await vault.create('pw-pw-pw-pw')
    await vault.setSecret(dek, 'main', new TextEncoder().encode(SEED))
    const again = await vault.unlock('pw-pw-pw-pw')
    expect(new TextDecoder().decode((await vault.getSecret(again, 'main'))!)).toBe(SEED)
    expect(rec.seen.map((s) => s.role)).toEqual(expect.arrayContaining(['importKey:AES-GCM', 'encrypt:plaintext']))
    expect(rec.leftovers()).toEqual([])
  })

  it('PBKDF2 vault: the password bytes handed to importKey are wiped', async () => {
    const rec = recordingCrypto()
    const vault = new Vault({ storage: memoryVaultStorage(), kdf: 'pbkdf2', crypto: rec.crypto })
    const dek = await vault.create('pw-pw-pw-pw')
    await vault.setSecret(dek, 'main', new TextEncoder().encode(SEED))
    await vault.unlock('pw-pw-pw-pw')
    expect(rec.seen.map((s) => s.role)).toContain('importKey:PBKDF2')
    expect(rec.leftovers()).toEqual([])
  })

  it('passkey: the PRF output copy is wiped on add and on unlock', async () => {
    const rec = recordingCrypto()
    const vault = new Vault({ storage: memoryVaultStorage(), scrypt: VAULT_MIN_SCRYPT, crypto: rec.crypto })
    const dek = await vault.create('pw-pw-pw-pw')
    await vault.setSecret(dek, 'main', new TextEncoder().encode(SEED))
    const id = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
    const prf = crypto.getRandomValues(new Uint8Array(32))
    await vault.addPasskey(dek, { id, prf: prf.slice(), label: 'x' })
    const viaPasskey = await vault.unlockWithPasskey(id, prf.slice())
    expect(new TextDecoder().decode((await vault.getSecret(viaPasskey, 'main'))!)).toBe(SEED)
    expect(rec.seen.map((s) => s.role)).toContain('importKey:HKDF')
    expect(rec.leftovers()).toEqual([])
  })
})
