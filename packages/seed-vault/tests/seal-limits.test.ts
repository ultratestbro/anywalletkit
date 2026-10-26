import { describe, expect, it } from 'vitest'
import { addProtector, decodeBackup, encodeBackup, isBackupError, openBackup, sealBackup } from '../src/index.js'

// Audit 2026-10-25 round 3, L6: sealBackup made backups that openBackup / decodeBackup then refused —
// a key protector's label over 256 characters, or a secret large enough to push the file past the
// 256 KB the decoder reads. The user found out only when restoring. Sealing (and adding a protector)
// now runs the same checks as opening.

const META = { type: 'mnemonic', fingerprint: 'bip32:abc' }
const key = (label: string) => ({ kind: 'key' as const, id: 'passkey:x', label, key: new Uint8Array(32).fill(5) })
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (isBackupError(e) ? e.code : String(e)))

describe('a backup that seals also opens', () => {
  it('a key protector label over 256 characters is refused at seal time', async () => {
    expect(await code(sealBackup('secret words', META, [key('x'.repeat(257))]))).toBe('invalid')
    const env = await sealBackup('secret words', META, [key('x'.repeat(256))])
    const opened = await openBackup(decodeBackup(encodeBackup(env)), { kind: 'key', id: 'passkey:x', key: new Uint8Array(32).fill(5) })
    expect(opened.text()).toBe('secret words')
    opened.dispose()
  })

  it('a secret too large for the decoder is refused at seal time', async () => {
    expect(await code(sealBackup(new Uint8Array(200 * 1024).fill(1), META, [key('k')]))).toBe('invalid')
  })

  it('adding a protector with an over-long label is refused too', async () => {
    const env = await sealBackup('secret words', META, [key('k')])
    expect(await code(addProtector(env, { kind: 'key', id: 'passkey:x', key: new Uint8Array(32).fill(5) }, { kind: 'key', id: 'passkey:y', label: 'y'.repeat(300), key: new Uint8Array(32).fill(6) }))).toBe('invalid')
  })
})
