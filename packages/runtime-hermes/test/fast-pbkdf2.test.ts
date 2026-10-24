import { pbkdf2Sync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import fastPbkdf2, { fromBase64, toBase64 } from '../src/fast-pbkdf2.js'

describe('fast-pbkdf2 shim', () => {
  it('matches node:crypto PBKDF2 for the parameters @ton/crypto uses (sha-512, base64 in/out)', async () => {
    const key = Buffer.from('word '.repeat(24).trim())
    const salt = Buffer.from('TON default seed')
    const got = await fastPbkdf2.derive(key.toString('base64'), salt.toString('base64'), 100, 64, 'sha-512')
    expect(got).toBe(pbkdf2Sync(key, salt, 100, 64, 'sha512').toString('base64'))
  })

  it('supports sha-256 and refuses other hashes', async () => {
    const got = await fastPbkdf2.derive(toBase64(new Uint8Array([1, 2, 3])), toBase64(new Uint8Array([4])), 10, 32, 'sha-256')
    expect(got).toBe(pbkdf2Sync(Buffer.from([1, 2, 3]), Buffer.from([4]), 10, 32, 'sha256').toString('base64'))
    await expect(fastPbkdf2.derive('', '', 1, 32, 'sha-1')).rejects.toThrow(/unsupported hash/)
  })

  it('base64 round-trips every length and agrees with Buffer', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff)
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
      expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes))
    }
    expect(() => fromBase64('not base64!')).toThrow(/invalid base64/)
  })
})
