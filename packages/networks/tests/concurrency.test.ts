import { describe, expect, it } from 'vitest'
import { NetworksTable, memoryJsonStorage, type JsonStorage, type NetworksState } from '../src/index.js'

// Audit 2026-10-25, #1.7: every write read the state, awaited, then saved a copy of what it read,
// so two writes at once lost one of them.
const ETH = 'eip155:1'
const BASE = 'eip155:8453'

/** Storage whose writes take a turn of the event loop, like AsyncStorage / chrome.storage. */
function slowStorage(): JsonStorage<NetworksState> & { value: NetworksState | null; failNext: boolean } {
  const s = {
    value: null as NetworksState | null,
    failNext: false,
    async get() { return s.value },
    async set(v: NetworksState) {
      await new Promise((r) => setTimeout(r, 1))
      if (s.failNext) { s.failNext = false; throw new Error('disk full') }
      s.value = JSON.parse(JSON.stringify(v))
    },
  }
  return s
}

describe('NetworksTable writes at once all land', () => {
  it('parallel addRpc / markRpc / enable / setOnlyOwnRpc on one table', async () => {
    const storage = slowStorage()
    const t = new NetworksTable(storage)
    await t.load()
    await Promise.all([
      t.addRpc(ETH, 'https://a.example'),
      t.addRpc(ETH, 'https://b.example'),
      t.addRpc(BASE, 'https://c.example'),
      t.enable('eip155:11155111', true),
      t.setOnlyOwnRpc(BASE, true),
    ])
    await Promise.all([
      t.markRpc(ETH, 'https://a.example', { ok: false, latencyMs: 1, error: 'down' }, 1),
      t.markRpc(ETH, 'https://b.example', { ok: false, latencyMs: 1, error: 'down' }, 1),
    ])
    for (const table of [t, new NetworksTable(memoryJsonStorage(storage.value))]) {
      const eth = (await table.get(ETH))!
      expect(eth.userRpcs.sort()).toEqual(['https://a.example', 'https://b.example'])
      expect(Object.keys(eth.issues).sort()).toEqual(['https://a.example', 'https://b.example'])
      const base = (await table.get(BASE))!
      expect(base.userRpcs).toEqual(['https://c.example'])
      expect(base.onlyOwnRpc).toBe(true)
      expect((await table.get('eip155:11155111'))!.enabled).toBe(true)
    }
  })

  it('a failed save leaves memory as stored, and the next write still lands', async () => {
    const storage = slowStorage()
    const t = new NetworksTable(storage)
    await t.load()
    storage.failNext = true
    await expect(t.addRpc(ETH, 'https://a.example')).rejects.toThrow(/disk full/)
    expect(t.getSync(ETH)!.userRpcs).toEqual([])
    await t.addRpc(ETH, 'https://b.example')
    expect(storage.value!.overrides[ETH]!.userRpcs).toEqual(['https://b.example'])
  })
})
