import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies } from '../src/index.js'
import { snapshot } from '../src/snapshot.js'

// Scan 2026-10-30 F15: snapshot() copied own keys but kept the caller's prototype, so a field the write
// INHERITS (or an inherited getter) was still live after the policies judged it. Now inherited data and
// accessors are read once into own values, and a prototype without methods is not kept.

const ALLOWED = '0x000000000000000000000000000000000000beef'
const DRAINER = '0x000000000000000000000000000000000000dead'

function recording() {
  const signed: Array<{ to?: unknown; data?: unknown }> = []
  const acc = createMockAccount({ chain: 'eip155:1' })
  acc.sendTransaction = async (tx: unknown) => { const t = tx as { to?: unknown; data?: unknown }; signed.push({ to: t.to, data: t.data }); return { hash: '0x1', fee: 0n } }
  return { acc, signed }
}

describe('scan 2026-10-30 F15: inherited fields are read once', () => {
  it('a prototype `to` edited during confirm is not signed', async () => {
    const { acc, signed } = recording()
    const proto: { to: string } = { to: ALLOWED }
    const tx = Object.assign(Object.create(proto) as object, { value: 1n })
    const g = applyPolicies(acc, { allowlist: { 'eip155:1': [ALLOWED] }, confirm: async () => { proto.to = DRAINER; return true } }, 'eip155:1')
    await g.sendTransaction(tx as never)
    expect(signed).toEqual([{ to: ALLOWED, data: undefined }])
  })

  it('a field added to a data prototype during confirm is not signed', async () => {
    const { acc, signed } = recording()
    const proto: { to: string; data?: string } = { to: ALLOWED }
    const tx = Object.assign(Object.create(proto) as object, { value: 1n })
    const g = applyPolicies(acc, { allowlist: { 'eip155:1': [ALLOWED] }, confirm: async () => { proto.data = '0xa9059cbb'; return true } }, 'eip155:1')
    await g.sendTransaction(tx as never)
    expect(signed).toEqual([{ to: ALLOWED, data: undefined }])
  })

  it('an inherited getter answering differently on a later read is read once', async () => {
    const { acc, signed } = recording()
    let confirmed = false
    const proto = { get to() { return confirmed ? DRAINER : ALLOWED } }
    const tx = Object.assign(Object.create(proto) as object, { value: 1n })
    const g = applyPolicies(acc, { allowlist: { 'eip155:1': [ALLOWED] }, confirm: () => { confirmed = true; return true } }, 'eip155:1')
    await g.sendTransaction(tx as never)
    expect(signed).toEqual([{ to: ALLOWED, data: undefined }])
  })

  it('control: an own `to` edited during confirm is not signed', async () => {
    const { acc, signed } = recording()
    const tx = { to: ALLOWED, value: 1n }
    const g = applyPolicies(acc, { allowlist: { 'eip155:1': [ALLOWED] }, confirm: async () => { tx.to = DRAINER; return true } }, 'eip155:1')
    await g.sendTransaction(tx)
    expect(signed).toEqual([{ to: ALLOWED, data: undefined }])
  })

  it('a class instance keeps its methods; its getters and prototype data become own values of the copy', () => {
    class Base { kind = 'base'; describe() { return `${this.kind}:${this.size}` } get size() { return this.bytes.length } constructor(readonly bytes: Uint8Array) {} }
    class Sub extends Base { get label() { return 'sub' } }
    ;(Sub.prototype as unknown as { tag: string }).tag = 'proto-data'
    const orig = new Sub(new Uint8Array([1, 2, 3]))
    const c = snapshot(orig)
    expect(c).toBeInstanceOf(Sub)
    expect(c.describe()).toBe('base:3')
    expect(Object.getOwnPropertyDescriptor(c, 'size')).toMatchObject({ value: 3, enumerable: false })
    expect(Object.getOwnPropertyDescriptor(c, 'label')).toMatchObject({ value: 'sub' })
    expect(Object.getOwnPropertyDescriptor(c, 'tag')).toMatchObject({ value: 'proto-data', enumerable: true })
    ;(Sub.prototype as unknown as { tag: string }).tag = 'edited'
    expect((c as unknown as { tag: string }).tag).toBe('proto-data')
    // spreading still shows only what it showed before, plus nothing from methods
    expect(Object.keys(c)).toEqual([...Object.keys(orig), 'tag'])
  })

  it('a data-only prototype is dropped; plain objects and arrays are unchanged', () => {
    const c = snapshot(Object.assign(Object.create({ to: ALLOWED }) as object, { value: 1n })) as { to: string; value: bigint }
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype)
    expect({ ...c }).toEqual({ to: ALLOWED, value: 1n })
    const arr = snapshot([1, { a: 2 }])
    expect(Object.getPrototypeOf(arr)).toBe(Array.prototype)
    expect(arr).toEqual([1, { a: 2 }])
    expect(Object.getPrototypeOf(snapshot(Object.create(null) as object))).toBeNull()
  })
})
