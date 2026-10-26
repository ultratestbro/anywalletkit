import { describe, expect, it } from 'vitest'
import { planUnstakeSteps } from '../src/protocol.js'

// Audit 2026-10-25 round 3, NS-4: planUnstakeSteps took whole accounts greedily (largest first) and
// refused amounts that had a valid plan. Accounts 1.1 / 1.8 / 2.1 / 2.3 SOL, minimum 1, unstake 4:
// 1.1 + 1.8 whole and 1.1 split off 2.1 (leaving 1.0) works, the greedy search found nothing.

const SOL = 1_000_000_000n
const acct = (sol: number, i: number) => ({ address: `A${i}`, delegated: BigInt(Math.round(sol * 1e9)) })

/** Every (whole set, optional split source) pair: the fewest steps, or null when nothing fits. */
function bruteSteps(pool: { address: string; delegated: bigint }[], amount: bigint, min: bigint): number | null {
  let best: number | null = null
  const n = pool.length
  for (let mask = 0; mask < 1 << n; mask++) {
    let sum = 0n, count = 0
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { sum += pool[i]!.delegated; count++ }
    if (sum === amount) { if (best === null || count < best) best = count; continue }
    if (sum > amount) continue
    const rest = amount - sum
    if (rest < min) continue
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue
      if (pool[i]!.delegated - rest >= min && (best === null || count + 1 < best)) best = count + 1
    }
  }
  return best
}

/** The plan is a valid one: right total, every split part ≥ min, no account used twice. */
function check(pool: { address: string; delegated: bigint }[], amount: bigint, min: bigint, plan: NonNullable<ReturnType<typeof planUnstakeSteps>>) {
  const used = new Set(plan.whole.map((a) => a.address))
  expect(used.size).toBe(plan.whole.length)
  let total = plan.whole.reduce((s, a) => s + a.delegated, 0n)
  if (plan.split) {
    expect(used.has(plan.split.source.address)).toBe(false)
    expect(plan.split.lamports >= min).toBe(true)
    expect(plan.split.source.delegated - plan.split.lamports >= min).toBe(true)
    total += plan.split.lamports
  }
  expect(total).toBe(amount)
  for (const a of plan.whole) expect(pool.includes(a)).toBe(true)
}

describe('planUnstakeSteps finds a plan whenever one exists, with the fewest steps', () => {
  it("the audit's case: 1.1 / 1.8 / 2.1 / 2.3, minimum 1, amount 4", () => {
    const pool = [1.1, 1.8, 2.1, 2.3].map(acct)
    const plan = planUnstakeSteps(pool, 4n * SOL, SOL)
    expect(plan).not.toBeNull()
    check(pool, 4n * SOL, SOL, plan!)
    expect(plan!.whole.length + (plan!.split ? 1 : 0)).toBe(3)
  })

  it('matches brute force on random small pools', () => {
    let seed = 7
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 }
    for (let round = 0; round < 1500; round++) {
      const n = 1 + Math.floor(rand() * 7)
      const pool = Array.from({ length: n }, (_, i) => acct(Math.round((1 + rand() * 4) * 10) / 10, i))
      const min = SOL
      const total = pool.reduce((s, a) => s + a.delegated, 0n)
      const amount = BigInt(Math.round(rand() * Number(total / 100_000_000n))) * 100_000_000n
      if (amount === 0n) continue
      const want = bruteSteps(pool, amount, min)
      const plan = planUnstakeSteps(pool, amount, min)
      if (want === null) { expect(plan, `${pool.map((a) => a.delegated)} → ${amount}`).toBeNull(); continue }
      expect(plan, `${pool.map((a) => a.delegated)} → ${amount}`).not.toBeNull()
      check(pool, amount, min, plan!)
      expect(plan!.whole.length + (plan!.split ? 1 : 0), `${pool.map((a) => a.delegated)} → ${amount}`).toBe(want)
    }
  })

  it('large pools (past the exhaustive bound) still get a greedy plan', () => {
    const pool = Array.from({ length: 20 }, (_, i) => acct(2, i))
    const plan = planUnstakeSteps(pool, 7n * SOL, SOL)
    expect(plan).not.toBeNull()
    check(pool, 7n * SOL, SOL, plan!)
  })
})
