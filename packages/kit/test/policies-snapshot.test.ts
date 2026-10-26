import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies, type WriteIntent } from '../src/index.js'
import { snapshot } from '../src/snapshot.js'

// Audit 2026-10-25 round 3, M2: the policies judged the caller's live argument object and then
// signed that same object, so anything that changed it between the check and the signature won:
// a getter that answers differently later, a confirm hook editing `intent.raw` or the caller's
// object, a timer during an await.

const ALLOWED = '0x000000000000000000000000000000000000beef'
const DRAINER = '0x000000000000000000000000000000000000dead'

/** A mock EVM account that records `to` / `data` at the moment it is asked to send. */
function recording() {
  const signed: Array<{ to: unknown; data: unknown }> = []
  const acc = createMockAccount({ chain: 'eip155:1' })
  acc.sendTransaction = async (tx: unknown) => { const t = tx as { to?: unknown; data?: unknown }; signed.push({ to: t.to, data: t.data instanceof Uint8Array ? Array.from(t.data) : t.data }); return { hash: '0x1', fee: 0n } }
  return { acc, signed }
}

describe('what gets signed is what was judged', () => {
  it('a getter that answers differently after confirm', async () => {
    const { acc, signed } = recording()
    let confirmed = false
    const tx = { get to() { return confirmed ? DRAINER : ALLOWED }, value: 1n }
    const g = applyPolicies(acc, { allowlist: { eip155: [ALLOWED] }, confirm: () => { confirmed = true; return true } }, 'eip155:1')
    await g.sendTransaction(tx as never)
    expect(signed).toEqual([{ to: ALLOWED, data: undefined }])
  })

  it('confirm editing intent.raw', async () => {
    const { acc, signed } = recording()
    const g = applyPolicies(acc, { blocklist: { eip155: [DRAINER] }, confirm: (i: WriteIntent) => { (i.raw as { to: string }).to = DRAINER; return true } }, 'eip155:1')
    await g.sendTransaction({ to: ALLOWED, value: 1n })
    expect(signed[0]!.to).toBe(ALLOWED)
  })

  it("confirm (or a timer during an await) editing the caller's object, nested bytes included", async () => {
    const { acc, signed } = recording()
    const tx = { to: ALLOWED, value: 1n, data: new Uint8Array([1, 2, 3]) }
    const g = applyPolicies(acc, {
      allowlist: { eip155: [ALLOWED] },
      confirm: async () => { await new Promise((r) => setTimeout(r, 1)); tx.to = DRAINER; tx.data[0] = 0xff; return true },
    }, 'eip155:1')
    await g.sendTransaction(tx)
    expect(signed).toEqual([{ to: ALLOWED, data: [1, 2, 3] }])
  })
})

describe('snapshot', () => {
  it('reads accessors once, keeps functions, copies bytes / dates / maps / sets, keeps prototypes, frozen state and cycles', () => {
    let reads = 0
    class Cellish { constructor(readonly bits: Uint8Array, readonly refs: Cellish[]) { Object.freeze(this) } hash() { return this.bits.length } }
    const fn = () => 1
    const src: Record<string, unknown> = {
      get once() { reads++; return reads }, fn, big: 5n, bytes: new Uint8Array([1]), buf: Buffer.from([2]),
      when: new Date(1), map: new Map([['a', { x: 1 }]]), set: new Set([1]), cell: new Cellish(new Uint8Array([7, 7]), []), list: [1, { y: 2 }],
    }
    src.self = src
    const c = snapshot(src)
    expect(reads).toBe(1)
    expect(c.once).toBe(1)
    expect(Object.getOwnPropertyDescriptor(c, 'once')).toMatchObject({ value: 1 })
    expect(c.fn).toBe(fn)
    expect(c.big).toBe(5n)
    expect(c.bytes).not.toBe(src.bytes)
    expect(c.bytes).toEqual(src.bytes)
    expect(Buffer.isBuffer(c.buf)).toBe(true)
    expect(c.when).not.toBe(src.when)
    expect((c.when as Date).getTime()).toBe(1)
    expect((c.map as Map<string, unknown>).get('a')).toEqual({ x: 1 })
    expect((c.map as Map<string, unknown>).get('a')).not.toBe((src.map as Map<string, unknown>).get('a'))
    expect(c.cell).toBeInstanceOf(Cellish)
    expect(c.cell).not.toBe(src.cell)
    expect((c.cell as Cellish).hash()).toBe(2)
    expect(Object.isFrozen(c.cell)).toBe(true)
    expect(Array.isArray(c.list)).toBe(true)
    expect(c.self).toBe(c)
  })
})
