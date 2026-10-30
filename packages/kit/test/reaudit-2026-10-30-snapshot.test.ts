import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies } from '../src/index.js'
import { snapshot } from '../src/snapshot.js'

// Reaudit 2026-10-30, #4: a prototype WITH methods was kept live by snapshot(), so a field added to it during
// `confirm` (a previously absent `data`) reached the signer although the policy judged an empty call. The copy now
// keeps the prototype for `instanceof` but answers only with what the chain held at snapshot time.

const ALLOWED = '0x000000000000000000000000000000000000beef'

function recording() {
  const signed: Array<{ to?: unknown; data?: unknown; value?: unknown }> = []
  const acc = createMockAccount({ chain: 'eip155:1' })
  acc.sendTransaction = async (tx: unknown) => { const t = tx as { to?: unknown; data?: unknown; value?: unknown }; signed.push({ to: t.to, data: t.data, value: t.value }); return { hash: '0x1', fee: 0n } }
  return { acc, signed }
}

describe('reaudit 2026-10-30 #4: a method-bearing prototype is read as it was', () => {
  it('data added to the prototype during confirm is not signed', async () => {
    const { acc, signed } = recording()
    const proto: { describe(): string; data?: string; value?: bigint } = { describe: () => 'tx' }
    const tx = Object.assign(Object.create(proto) as object, { to: ALLOWED })
    const g = applyPolicies(acc, { allowlist: { 'eip155:1': [ALLOWED] }, confirm: async () => { proto.data = '0xa9059cbb'; proto.value = 10n ** 18n; return true } }, 'eip155:1')
    await g.sendTransaction(tx as never)
    expect(signed).toEqual([{ to: ALLOWED, data: undefined, value: undefined }])
  })

  it('a class field added or a method replaced on the class after the snapshot is not seen; instanceof holds', () => {
    class Tx { constructor(readonly to: string) {} encode() { return `to:${this.to}` } }
    const copy = snapshot(new Tx(ALLOWED))
    ;(Tx.prototype as unknown as { data: string }).data = '0xa9059cbb'
    const original = Tx.prototype.encode
    Tx.prototype.encode = function () { return 'evil' }
    try {
      expect(copy).toBeInstanceOf(Tx)
      expect((copy as unknown as { data?: string }).data).toBeUndefined()
      expect('data' in copy).toBe(false)
      expect(copy.encode()).toBe(`to:${ALLOWED}`)
      expect(String(copy)).toBe('[object Object]')
      expect(Object.prototype.hasOwnProperty.call(copy, 'to')).toBe(true)
      expect(JSON.stringify(copy)).toBe(JSON.stringify({ to: ALLOWED }))
    } finally {
      Tx.prototype.encode = original
      delete (Tx.prototype as unknown as { data?: string }).data
    }
  })

  it('a method that writes to `this` writes to the copy, not through a setter added later', () => {
    class Counter { n = 0; bump() { this.n++; (this as unknown as { extra: number }).extra = 1; return this.n } }
    const copy = snapshot(new Counter())
    let hit = false
    Object.defineProperty(Counter.prototype, 'extra', { set() { hit = true }, configurable: true })
    try {
      expect(copy.bump()).toBe(1)
      expect((copy as unknown as { extra: number }).extra).toBe(1)
      expect(hit).toBe(false)
    } finally { delete (Counter.prototype as unknown as { extra?: number }).extra }
  })

  it('cycles and nested class instances keep pointing at the copies', () => {
    class Node { next?: Node; constructor(readonly id: number) {} label() { return `n${this.id}` } }
    const a = new Node(1); const b = new Node(2); a.next = b; b.next = a
    const c = snapshot(a)
    expect(c.next!.next).toBe(c)
    expect(c.next).toBeInstanceOf(Node)
    expect(c.next!.label()).toBe('n2')
  })
})
