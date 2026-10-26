import { describe, expect, it } from 'vitest'
import type { ActivityItem, ActivityKind, ChainTx, IWalletAccount, IWalletAccountReadOnly } from '@anywalletkit/core'
import { createMockAccount } from './mock-account.js'

/**
 * Activity fixtures: recorded real transactions a module must recognize through
 * `describeActivity`. JSON on disk (bigints as decimal strings) so fixtures can be
 * captured from explorers / the live harness and reviewed in a diff.
 */
export interface ActivityFixtureJson {
  /** Why this tx is here, e.g. "Aave v3 supply USDC on Base (funded test 2026-10-10)". */
  note?: string
  /** The wallet's own addresses on that chain. */
  own: string[]
  tx: Omit<ChainTx, 'nativeValue' | 'fee' | 'block' | 'transfers'> & {
    nativeValue: string
    fee?: string
    block?: string
    transfers: Array<Omit<ChainTx['transfers'][number], 'amount'> & { amount: string }>
  }
  expect: {
    kind: ActivityKind
    /** Substring the title must contain (case-insensitive). */
    title?: string
    /** Assets that must appear, by token id (null = native) and exact base-unit amount. */
    assetsIn?: Array<{ token: string | null; amount: string }>
    assetsOut?: Array<{ token: string | null; amount: string }>
    counterparty?: string
  }
}

export function parseActivityFixture(f: ActivityFixtureJson): { tx: ChainTx; own: Set<string> } {
  const { fee, block, ...rest } = f.tx
  const tx: ChainTx = { ...rest, nativeValue: BigInt(f.tx.nativeValue), transfers: f.tx.transfers.map((t) => ({ ...t, amount: BigInt(t.amount) })) }
  if (fee !== undefined) tx.fee = BigInt(fee)
  if (block !== undefined) tx.block = BigInt(block)
  return { tx, own: new Set(f.own.flatMap((a) => (a.startsWith('0x') ? [a, a.toLowerCase()] : [a]))) }
}

/** Account methods that sign or send: describing a transaction must call none of them. */
const WRITE_METHOD = /^(sign|send|transfer)/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor<P> = new (account: IWalletAccountReadOnly | IWalletAccount, config?: any) => P

export interface ActivitySuiteOptions<P> {
  Protocol: Ctor<P>
  config?: unknown
  /** Recorded transactions this module must describe. At least one is required: a module that recognizes nothing is not ready. */
  fixtures: ActivityFixtureJson[]
  /** Transactions that look similar but are NOT this module's; `describeActivity` must return null. */
  negatives?: ActivityFixtureJson[]
}

const sameAsset = (a: { token: string | null; amount: bigint }, e: { token: string | null; amount: string }) =>
  (a.token === e.token || (a.token && e.token && a.token.toLowerCase() === e.token.toLowerCase())) && a.amount === BigInt(e.amount)

/** The activity half of the conformance gate: every fixture classified, every negative refused, output well-formed. */
export function describeActivitySuite<P extends object>(name: string, o: ActivitySuiteOptions<P>): void {
  describe(`${name}: activity (describeActivity)`, () => {
    it('ships at least one recorded fixture', () => {
      expect(o.fixtures.length, 'add fixtures/activity/*.json captured from a real transaction').toBeGreaterThan(0)
    })

    for (const [i, f] of o.fixtures.entries()) {
      it(`recognizes fixture ${i + 1}${f.note ? `: ${f.note}` : ''}`, () => {
        const account = createMockAccount()
        const p = new o.Protocol(account, o.config) as { describeActivity: (tx: ChainTx, ctx: { own: Set<string> }) => ActivityItem | null }
        const { tx, own } = parseActivityFixture(f)
        const item = p.describeActivity(tx, { own })
        const writes = account.calls.filter((c) => WRITE_METHOD.test(c.method)).map((c) => c.method)
        expect(writes, `describeActivity called ${writes.join(', ')} on the account`).toEqual([])
        expect(item, 'describeActivity returned null for a fixture this module must recognize').not.toBeNull()
        const a = item as ActivityItem
        expect(a.kind).toBe(f.expect.kind)
        expect(a.id).toBe(`${tx.chain}:${tx.hash}`)
        expect(a.chain).toBe(tx.chain)
        expect(a.hash).toBe(tx.hash)
        expect(a.status).toBe(tx.status)
        expect(typeof a.title).toBe('string')
        expect(a.title.length).toBeGreaterThan(0)
        expect(Array.isArray(a.assetsIn) && Array.isArray(a.assetsOut)).toBe(true)
        for (const x of [...a.assetsIn, ...a.assetsOut]) expect(x.amount >= 0n, 'amounts are non-negative base units').toBe(true)
        if (f.expect.title) expect(a.title.toLowerCase()).toContain(f.expect.title.toLowerCase())
        for (const e of f.expect.assetsIn ?? []) expect(a.assetsIn.some((x) => sameAsset(x, e)), `assetsIn missing ${e.token ?? 'native'} ${e.amount}`).toBe(true)
        for (const e of f.expect.assetsOut ?? []) expect(a.assetsOut.some((x) => sameAsset(x, e)), `assetsOut missing ${e.token ?? 'native'} ${e.amount}`).toBe(true)
        if (f.expect.counterparty) expect((a.counterparty ?? '').toLowerCase()).toBe(f.expect.counterparty.toLowerCase())
      })
    }

    for (const [i, f] of (o.negatives ?? []).entries()) {
      it(`returns null for negative ${i + 1}${f.note ? `: ${f.note}` : ''}`, () => {
        const p = new o.Protocol(createMockAccount(), o.config) as { describeActivity: (tx: ChainTx, ctx: { own: Set<string> }) => ActivityItem | null }
        const { tx, own } = parseActivityFixture(f)
        expect(p.describeActivity(tx, { own })).toBeNull()
      })
    }

    it('is pure: a foreign transfer yields null and nothing is sent', () => {
      const account = createMockAccount()
      const p = new o.Protocol(account, o.config) as { describeActivity: (tx: ChainTx, ctx: { own: Set<string> }) => ActivityItem | null }
      const tx: ChainTx = {
        chain: 'eip155:1', hash: '0x' + 'ab'.repeat(32), time: 1_700_000_000, status: 'confirmed',
        address: '0x000000000000000000000000000000000000dEaD', from: '0x000000000000000000000000000000000000dEaD',
        to: '0x00000000000000000000000000000000000000A1', nativeValue: 1n, transfers: [{ token: null, from: '0x000000000000000000000000000000000000dEaD', to: '0x00000000000000000000000000000000000000A1', amount: 1n }],
      }
      expect(p.describeActivity(tx, { own: new Set(['0x000000000000000000000000000000000000dead']) })).toBeNull()
      expect(((account as { sent?: unknown[] }).sent ?? []).length).toBe(0)
      // Not only sends: describing must not sign anything either (it used to check `sent` alone).
      const writes = account.calls.filter((c) => WRITE_METHOD.test(c.method)).map((c) => c.method)
      expect(writes, `describeActivity called ${writes.join(', ')} on the account`).toEqual([])
    })
  })
}
