import { describe, expect, it } from 'vitest'
import {
  BackupError,
  addProtector,
  decodeBackup,
  describeBackup,
  encodeBackup,
  isBackupError,
  openBackup,
  removeProtector,
  sealBackup,
  type BackupEnvelope,
} from '../src/index.js'

const SECRET = JSON.stringify({ type: 'mnemonic', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' })
const META = { type: 'mnemonic', fingerprint: '73c5da0a', label: 'Main' }
const PASSWORD = 'violet harbor anchor lantern'
const key = (b: number) => new Uint8Array(32).fill(b)

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.catch((e: unknown) => e)
  expect(isBackupError(err)).toBe(true)
  expect((err as BackupError).code).toBe(code)
}

describe('seed-vault envelope', () => {
  it('seals with a password and opens it again; the JSON round-trips', async () => {
    const env = await sealBackup(SECRET, META, [{ kind: 'password', password: PASSWORD }])
    expect(env.format).toBe('forgewallet-backup')
    expect(env.protectors[0]).toMatchObject({ kind: 'password', kdf: { alg: 'argon2id', m: 19456, t: 2, p: 1 } })
    const text = encodeBackup(env)
    expect(text).not.toContain('abandon')
    const opened = await openBackup(decodeBackup(text), { kind: 'password', password: PASSWORD })
    expect(opened.text()).toBe(SECRET)
    expect(opened.meta).toEqual(META)
    opened.dispose()
    expect(opened.bytes.every((b) => b === 0)).toBe(true)
    expect(() => opened.text()).toThrow(/disposed/)
  })

  it('normalizes the password (NFKC): a composed and a decomposed é open the same backup', async () => {
    const env = await sealBackup(SECRET, META, [{ kind: 'password', password: 'café au lait please' }])
    const opened = await openBackup(env, { kind: 'password', password: 'café au lait please' })
    expect(opened.text()).toBe(SECRET)
  })

  it('refuses a wrong password, a short password and a password-less unlock', async () => {
    const env = await sealBackup(SECRET, META, [{ kind: 'password', password: PASSWORD }])
    await expectCode(openBackup(env, { kind: 'password', password: 'violet harbor anchor lanterns' }), 'wrong-password')
    await expectCode(sealBackup(SECRET, META, [{ kind: 'password', password: 'short' }]), 'weak-password')
    await expectCode(openBackup(env, { kind: 'key', id: 'passkey:1', key: key(1) }), 'invalid')
  })

  it('opens with any one of several protectors', async () => {
    const env = await sealBackup(SECRET, META, [
      { kind: 'password', password: PASSWORD },
      { kind: 'key', id: 'passkey:abc', key: key(7), label: 'iPhone passkey' },
      { kind: 'key', id: 'icloud-keychain', key: key(9) },
    ])
    for (const unlock of [
      { kind: 'password', password: PASSWORD },
      { kind: 'key', id: 'passkey:abc', key: key(7) },
      { kind: 'key', id: 'icloud-keychain', key: key(9) },
    ] as const) {
      expect((await openBackup(env, unlock)).text()).toBe(SECRET)
    }
    await expectCode(openBackup(env, { kind: 'key', id: 'passkey:abc', key: key(8) }), 'wrong-key')
    expect(describeBackup(env).protectors).toEqual([
      { kind: 'password' },
      { kind: 'key', id: 'passkey:abc', label: 'iPhone passkey' },
      { kind: 'key', id: 'icloud-keychain' },
    ])
  })

  it('adds and removes protectors without re-sealing the payload; the last one stays', async () => {
    const env = await sealBackup(SECRET, META, [{ kind: 'key', id: 'icloud-keychain', key: key(9) }])
    const withPw = await addProtector(env, { kind: 'key', id: 'icloud-keychain', key: key(9) }, { kind: 'password', password: PASSWORD })
    expect(withPw.payload).toEqual(env.payload)
    expect((await openBackup(withPw, { kind: 'password', password: PASSWORD })).text()).toBe(SECRET)
    const pwOnly = removeProtector(withPw, { kind: 'key', id: 'icloud-keychain' })
    await expectCode(openBackup(pwOnly, { kind: 'key', id: 'icloud-keychain', key: key(9) }), 'invalid')
    expect(() => removeProtector(pwOnly, { kind: 'password' })).toThrow(/last protector/)
    // Changing the password replaces the password protector.
    const changed = await addProtector(pwOnly, { kind: 'password', password: PASSWORD }, { kind: 'password', password: 'a brand new long passphrase' })
    expect(changed.protectors).toHaveLength(1)
    await expectCode(openBackup(changed, { kind: 'password', password: PASSWORD }), 'wrong-password')
    expect((await openBackup(changed, { kind: 'password', password: 'a brand new long passphrase' })).text()).toBe(SECRET)
  })

  it('authenticates the metadata: a swapped fingerprint or label does not open', async () => {
    const env = await sealBackup(SECRET, META, [{ kind: 'key', id: 'k', key: key(1) }])
    for (const meta of [{ ...META, fingerprint: 'deadbeef' }, { ...META, label: 'Savings' }, { type: 'privateKey', fingerprint: META.fingerprint }]) {
      await expectCode(openBackup({ ...env, meta }, { kind: 'key', id: 'k', key: key(1) }), 'corrupted')
    }
    await expectCode(openBackup({ ...env, createdAt: env.createdAt + 1 }, { kind: 'key', id: 'k', key: key(1) }), 'corrupted')
  })

  it('authenticates each protector descriptor: lowering the Argon2 cost or renaming a key does not open', async () => {
    const env = await sealBackup(SECRET, META, [
      { kind: 'password', password: PASSWORD },
      { kind: 'key', id: 'k', key: key(1) },
    ])
    const pw = env.protectors[0] as Extract<BackupEnvelope['protectors'][number], { kind: 'password' }>
    const weakened = { ...env, protectors: [{ ...pw, kdf: { ...pw.kdf, t: 1 } }, env.protectors[1]!] }
    await expectCode(openBackup(weakened, { kind: 'password', password: PASSWORD }), 'wrong-password')
    const k = env.protectors[1] as Extract<BackupEnvelope['protectors'][number], { kind: 'key' }>
    const renamed = { ...env, protectors: [env.protectors[0]!, { ...k, id: 'other' }] }
    await expectCode(openBackup(renamed, { kind: 'key', id: 'other', key: key(1) }), 'wrong-key')
  })

  it('detects a flipped ciphertext byte', async () => {
    const env = await sealBackup(SECRET, META, [{ kind: 'key', id: 'k', key: key(1) }])
    const ct = env.payload.ct
    const flipped = (ct[5] === 'A' ? 'B' : 'A') + ''
    const bad = { ...env, payload: { ...env.payload, ct: ct.slice(0, 5) + flipped + ct.slice(6) } }
    await expectCode(openBackup(bad, { kind: 'key', id: 'k', key: key(1) }), 'corrupted')
  })

  it('uses a fresh data key, nonce and salt every time', async () => {
    const a = await sealBackup(SECRET, META, [{ kind: 'key', id: 'k', key: key(1) }])
    const b = await sealBackup(SECRET, META, [{ kind: 'key', id: 'k', key: key(1) }])
    expect(a.payload.ct).not.toBe(b.payload.ct)
    expect(a.payload.nonce).not.toBe(b.payload.nonce)
    expect(a.protectors[0]!.ct).not.toBe(b.protectors[0]!.ct)
  })

  it('uses an injected native Argon2id and refuses a cost below the default', async () => {
    const calls: number[] = []
    const { argon2id } = await import('@noble/hashes/argon2.js')
    const native = async (pw: Uint8Array, salt: Uint8Array, p: { m: number; t: number; p: number }) => {
      calls.push(p.m)
      return argon2id(pw, salt, { ...p, dkLen: 32 })
    }
    const env = await sealBackup(SECRET, META, [{ kind: 'password', password: PASSWORD }], { argon2id: native, argon2: { m: 32 * 1024, t: 3, p: 1 } })
    expect(env.protectors[0]).toMatchObject({ kdf: { m: 32768, t: 3 } })
    // Opening without the native implementation still works (pure JS, same RFC 9106 output).
    expect((await openBackup(env, { kind: 'password', password: PASSWORD })).text()).toBe(SECRET)
    expect(calls).toEqual([32768])
    await expectCode(sealBackup(SECRET, META, [{ kind: 'password', password: PASSWORD }], { argon2: { m: 4096, t: 1, p: 1 } }), 'invalid')
  })

  it('rejects malformed, foreign and dangerous files on decode', () => {
    const good = JSON.parse(JSON.stringify({ format: 'forgewallet-backup', v: 1, createdAt: 1, meta: META, payload: { alg: 'xchacha20poly1305', nonce: 'AAAA', ct: 'AAAA' }, protectors: [{ kind: 'key', id: 'k', salt: 'AAAA', nonce: 'AAAA', ct: 'AAAA' }] }))
    expect(() => decodeBackup(JSON.stringify(good))).not.toThrow()
    const cases: Array<[unknown, string]> = [
      ['not json', 'invalid'],
      [{ ...good, format: 'other' }, 'unsupported'],
      [{ ...good, v: 2 }, 'unsupported'],
      [{ ...good, payload: { ...good.payload, alg: 'aes-256-gcm' } }, 'unsupported'],
      [{ ...good, protectors: [] }, 'invalid'],
      [{ ...good, protectors: [{ kind: 'shamir' }] }, 'invalid'],
      [{ ...good, protectors: [{ kind: 'password', kdf: { alg: 'argon2id', salt: 'AAAA', m: 4 * 1024 * 1024, t: 3, p: 1 }, nonce: 'AAAA', ct: 'AAAA' }] }, 'invalid'],
      [{ ...good, protectors: [{ kind: 'password', kdf: { alg: 'scrypt', salt: 'AAAA', m: 1, t: 1, p: 1 }, nonce: 'AAAA', ct: 'AAAA' }] }, 'unsupported'],
      [{ ...good, protectors: [good.protectors[0], good.protectors[0]] }, 'invalid'],
      [{ ...good, meta: { type: 'mnemonic' } }, 'invalid'],
    ]
    for (const [value, code] of cases) {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      let err: unknown
      try {
        decodeBackup(text)
      } catch (e) {
        err = e
      }
      expect(isBackupError(err, code as never), `${text.slice(0, 80)} → ${code}`).toBe(true)
    }
    // Unknown extra fields are dropped, not carried along.
    const extra = decodeBackup(JSON.stringify({ ...good, evil: 1, meta: { ...META, evil: 2 } }))
    expect(JSON.stringify(extra)).not.toContain('evil')
  })

  it('needs at least one protector, metadata and a secret', async () => {
    await expectCode(sealBackup(SECRET, META, []), 'invalid')
    await expectCode(sealBackup('', META, [{ kind: 'key', id: 'k', key: key(1) }]), 'invalid')
    await expectCode(sealBackup(SECRET, { type: 'mnemonic' } as never, [{ kind: 'key', id: 'k', key: key(1) }]), 'invalid')
    await expectCode(sealBackup(SECRET, META, [{ kind: 'key', id: 'k', key: new Uint8Array(16) }]), 'invalid')
    await expectCode(sealBackup(SECRET, META, [{ kind: 'key', id: 'k', key: key(1) }, { kind: 'key', id: 'k', key: key(2) }]), 'invalid')
  })
})
