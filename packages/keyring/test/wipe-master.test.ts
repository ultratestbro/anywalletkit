import { afterEach, describe, expect, it, vi } from 'vitest'
import { HDKey } from '@scure/bip32'
import { ABANDON, fresh } from './helpers.js'

// Audit 2026-10-25 round 3, L1 (derive part, keyring): importMnemonic built the BIP-32 master only to
// hash its public key for the fingerprint and left its private key in memory; exportPrivateKey kept
// the derived key's own buffer next to the copy it returned.
describe('keyring wipes the key material it only used in passing', () => {
  afterEach(() => vi.restoreAllMocks())

  it('the master made for the fingerprint is wiped', async () => {
    const made: HDKey[] = []
    const real = HDKey.fromMasterSeed.bind(HDKey)
    vi.spyOn(HDKey, 'fromMasterSeed').mockImplementation((seed, versions) => { const n = real(seed, versions); made.push(n); return n })
    const { keyring } = await fresh()
    const { source } = await keyring.importMnemonic(ABANDON)
    expect(source.fingerprint).toMatch(/^bip32:[0-9a-f]{32}$/)
    expect(made.length).toBeGreaterThan(0)
    for (const n of made) expect(n.privateKey).toBeNull()
  })
})
