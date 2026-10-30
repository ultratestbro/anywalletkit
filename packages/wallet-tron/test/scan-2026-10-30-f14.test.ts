import { describe, expect, it } from 'vitest'
import { HistoryUnavailableError, createTronHistory, type HistoryFetch } from '../src/index.js'

// scan 2026-10-30 F14: a non-numeric / missing block_timestamp made listActivity spin forever on cached rows.
// The spin is a microtask loop (timers never fire), so the row's timestamp is a getter that breaks the loop
// after many reads: if the fix regressed the call would end with NO_PROGRESS instead of hanging the test.
const ME = 'TVSz6xJL2M53HDZyFTeDcGCmEDdwmU4zbv'
const NO_PROGRESS = 'no-progress: block_timestamp read 100000 times'
const USDT = { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', decimals: 6 }

function hostile(value: unknown, list: 'trc20' | 'tx' = 'trc20') {
  let reads = 0
  const guard = () => { if (++reads > 100_000) throw new Error(NO_PROGRESS); return value }
  const trc20 = { transaction_id: 'ab'.repeat(32), from: ME, to: ME, type: 'Transfer', value: '1', token_info: USDT, get block_timestamp() { return guard() } }
  const tx = { txID: 'cd'.repeat(32), raw_data: { contract: [] }, ret: [{ contractRet: 'SUCCESS' }], get block_timestamp() { return guard() } }
  const fetch: HistoryFetch = async (url) => {
    const isTrc20 = new URL(url).pathname.endsWith('/trc20')
    const data = isTrc20 ? (list === 'trc20' ? [trc20] : []) : (list === 'tx' ? [tx] : [])
    return { ok: true, status: 200, json: async () => ({ data, success: true, meta: {} }) }
  }
  return fetch
}

describe('scan 2026-10-30 F14: Tron history rejects malformed timestamps instead of looping', () => {
  const BAD: Array<[string, unknown]> = [['string', '1'], ['missing', undefined], ['NaN', Number.NaN], ['negative', -1], ['fractional', 1.5], ['unsafe', 2 ** 60], ['Infinity', Number.POSITIVE_INFINITY]]
  for (const [name, value] of BAD) {
    it(`trc20 row with ${name} timestamp: listActivity settles with HistoryUnavailableError`, async () => {
      const source = createTronHistory({ fetch: hostile(value), rateLimit: 1000 })
      const err = await source.listActivity(ME, { limit: 5 }).then(() => null, (e: Error) => e)
      expect(err?.message).not.toBe(NO_PROGRESS)
      expect(err).toBeInstanceOf(HistoryUnavailableError)
      expect((err as HistoryUnavailableError).reason).toMatch(/malformed block_timestamp/)
    })
  }
  for (const [name, value] of BAD.filter(([n]) => n !== 'missing')) {
    it(`transaction row with ${name} timestamp: listActivity settles with HistoryUnavailableError`, async () => {
      const source = createTronHistory({ fetch: hostile(value, 'tx'), rateLimit: 1000 })
      const err = await source.listActivity(ME, { limit: 5 }).then(() => null, (e: Error) => e)
      expect(err?.message).not.toBe(NO_PROGRESS)
      expect(err).toBeInstanceOf(HistoryUnavailableError)
    })
  }
  it('a data field that is not a list is refused', async () => {
    const fetch: HistoryFetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { 0: {} }, success: true, meta: {} }) })
    const err = await createTronHistory({ fetch, rateLimit: 1000 }).listActivity(ME).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(HistoryUnavailableError)
  })
  it('control: an honest numeric timestamp still lists the row', async () => {
    const page = await createTronHistory({ fetch: hostile(1_700_000_000_000), rateLimit: 1000 }).listActivity(ME, { limit: 5 })
    expect(page.items).toHaveLength(1)
    expect(page.cursor).toBeUndefined()
  })
})
