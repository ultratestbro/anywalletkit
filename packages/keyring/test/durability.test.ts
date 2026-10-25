import { describe, expect, it } from 'vitest'
import { Keyring } from '../src/index.js'
import { ABANDON, CHAINS, MemorySecrets, MemoryStorage, fresh } from './helpers.js'

// Audit 2026-10-25, findings 4 and 7: a source's secret outlives every failure of removeSource
// (metadata first, then the secret), and parallel imports of one phrase cannot both land.

const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const evmOnly = { evm: CHAINS.evm }

/** Secret storage whose delete fails while `failDelete` is set. */
class FlakySecrets extends MemorySecrets {
  failDelete = false
  deletes = 0
  override async delete(id: string) {
    this.deletes++
    if (this.failDelete) throw new Error('keychain locked')
    await super.delete(id)
  }
}

async function withSecrets(secrets: MemorySecrets, storage = new MemoryStorage()) {
  return { keyring: await Keyring.load({ storage, secrets, chains: evmOnly }), storage, secrets }
}

describe('removeSource never loses a key it did not remove', () => {
  it('save fails → the source, its accounts and its secret are all still there', async () => {
    const { keyring, storage, secrets } = await fresh(evmOnly)
    const { source, accounts } = await keyring.importMnemonic(ABANDON)
    storage.failNext = true
    await expect(keyring.removeSource(source.id)).rejects.toThrow(/disk full/)
    expect(secrets.map.has(source.id)).toBe(true)
    expect(keyring.listSources().map((s) => s.id)).toEqual([source.id])
    // the key still signs
    await expect(keyring.withAccount(accounts[0]!.id, 'evm', (a) => a.sign('still here'))).resolves.toMatch(/^0x/)
    // and a reload sees the same
    const again = await Keyring.load({ storage, secrets, chains: evmOnly })
    expect(again.listSources().map((s) => s.id)).toEqual([source.id])
    await expect(again.exportSecret(source.id)).resolves.toMatchObject({ secret: ABANDON })
  })

  it('delete fails → the source is gone, the secret is deleted on the next load', async () => {
    const secrets = new FlakySecrets()
    const { keyring, storage } = await withSecrets(secrets)
    const { source } = await keyring.importMnemonic(ABANDON)
    secrets.failDelete = true
    await expect(keyring.removeSource(source.id)).resolves.toBeUndefined()
    expect(keyring.listSources()).toEqual([])
    expect(secrets.map.has(source.id)).toBe(true) // could not delete yet…
    expect(storage.state?.pendingSecretDeletes).toEqual([source.id]) // …and it is written down
    secrets.failDelete = false
    const again = await Keyring.load({ storage, secrets, chains: evmOnly })
    expect(secrets.map.has(source.id)).toBe(false)
    expect(storage.state?.pendingSecretDeletes ?? []).toEqual([])
    expect(again.state.pendingSecretDeletes ?? []).toEqual([])
  })

  it('the process dies between the two steps → the next load finishes the delete', async () => {
    // State as the first step left it: the source is gone from metadata, the secret is not deleted yet.
    const secrets = new MemorySecrets()
    const { keyring, storage } = await withSecrets(secrets)
    const keep = await keyring.importMnemonic(OTHER)
    const { source } = await keyring.importMnemonic(ABANDON)
    const crashed = structuredClone(storage.state!)
    crashed.sources = crashed.sources.filter((s) => s.id !== source.id)
    crashed.accounts = crashed.accounts.filter((a) => a.sourceId !== source.id)
    crashed.pendingSecretDeletes = [source.id]
    storage.state = crashed
    const again = await Keyring.load({ storage, secrets, chains: evmOnly })
    expect(secrets.map.has(source.id)).toBe(false)
    expect(secrets.map.has(keep.source.id)).toBe(true)
    expect(again.listSources().map((s) => s.id)).toEqual([keep.source.id])
    expect(storage.state?.pendingSecretDeletes ?? []).toEqual([])
  })

  it('a successful remove leaves no tombstone behind', async () => {
    const { keyring, storage, secrets } = await fresh(evmOnly)
    const { source } = await keyring.importMnemonic(ABANDON)
    await keyring.removeSource(source.id)
    expect(secrets.map.size).toBe(0)
    expect(storage.state?.pendingSecretDeletes ?? []).toEqual([])
  })

  it('an id still waiting for its secret delete cannot be adopted', async () => {
    const secrets = new FlakySecrets()
    const { keyring } = await withSecrets(secrets)
    secrets.map.set('main', JSON.stringify({ type: 'mnemonic', mnemonic: ABANDON }))
    const { source } = await keyring.importMnemonic(ABANDON, { adoptId: 'main' })
    secrets.failDelete = true
    await keyring.removeSource(source.id)
    // the pending delete would wipe the secret the app re-adopts under the same id
    await expect(keyring.importMnemonic(ABANDON, { adoptId: 'main' })).rejects.toMatchObject({ code: 'invalid-input' })
  })
})

describe('parallel imports', () => {
  it('two imports of one phrase at once → one source, one duplicate error, one secret', async () => {
    const { keyring, storage, secrets } = await fresh(evmOnly)
    const results = await Promise.allSettled([keyring.importMnemonic(ABANDON), keyring.importMnemonic(` ${ABANDON.toUpperCase()} `)])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toMatchObject({ code: 'duplicate' })
    expect(keyring.listSources()).toHaveLength(1)
    expect(storage.state?.sources).toHaveLength(1)
    expect([...secrets.map.keys()]).toEqual([keyring.listSources()[0]!.id])
  })

  it('two different phrases at once both land, and both still sign after a reload', async () => {
    const { keyring, storage, secrets } = await fresh(evmOnly)
    const [a, b] = await Promise.all([keyring.importMnemonic(ABANDON), keyring.importMnemonic(OTHER)])
    const again = await Keyring.load({ storage, secrets, chains: evmOnly })
    expect(again.listSources().map((s) => s.id).sort()).toEqual([a.source.id, b.source.id].sort())
    for (const { accounts } of [a, b]) await expect(again.withAccount(accounts[0]!.id, 'evm', (x) => x.sign('hi'))).resolves.toMatch(/^0x/)
  })

  it('a failed save after the secret was written removes that secret again', async () => {
    const { keyring, storage, secrets } = await fresh(evmOnly)
    storage.failNext = true
    await expect(keyring.importMnemonic(ABANDON)).rejects.toThrow(/disk full/)
    expect(secrets.map.size).toBe(0)
    expect(keyring.listSources()).toEqual([])
    await expect(keyring.importMnemonic(ABANDON)).resolves.toBeDefined()
  })
})
