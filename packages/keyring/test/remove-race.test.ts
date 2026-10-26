import { describe, expect, it } from 'vitest'
import { ABANDON, fresh } from './helpers.js'

// Audit 2026-10-25 round 3, L4: addAccount / discovery / completeAddresses read the source, then
// awaited the secret and the derivation, then saved. A removeSource in between ran first; the save
// then added an account whose source was gone — an orphan, which could even become active.
describe('a source removed while an account is being added', () => {
  it('addAccount fails with not-found and leaves no orphan', async () => {
    const { keyring } = await fresh()
    const main = await keyring.importMnemonic(ABANDON)
    const other = await keyring.importMnemonic('legal winner thank year wave sausage worth useful legal winner thank yellow')
    const adding = keyring.addAccount(main.source.id)
    await keyring.removeSource(main.source.id)
    await expect(adding).rejects.toMatchObject({ code: 'not-found' })
    expect(keyring.listAccounts().every((a) => a.sourceId === other.source.id)).toBe(true)
    expect(keyring.activeAccount?.sourceId).toBe(other.source.id)
  })

  it('discovery (store) fails the same way', async () => {
    const { keyring } = await fresh()
    const main = await keyring.importMnemonic(ABANDON)
    const finding = keyring.discoverAccounts(main.source.id, { isUsed: async () => true, maxIndex: 3 })
    await keyring.removeSource(main.source.id)
    await expect(finding).rejects.toMatchObject({ code: 'not-found' })
    expect(keyring.listAccounts()).toEqual([])
  })
})
