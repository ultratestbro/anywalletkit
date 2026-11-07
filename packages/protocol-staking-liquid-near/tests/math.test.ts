import { describe, expect, it } from 'vitest'
import { NearRpc } from '@anywalletkit/wallet-near'
import { TYPICAL_EPOCH_MS, aprFromPrices, epochStartsAt, nearForShares, readEpoch, sharesForNear, valueAtPrice } from '../src/index.js'
import { EPOCH, EPOCH_LEN, FakeNear, MS_PER_BLOCK, NEAR } from './fake-near.js'

const YEAR_MS = 365.25 * 86_400_000

describe('share math (internal.rs rounding)', () => {
  const totals = { totalStaked: 12_766_424_855_885_013_372_832_084_904_913n, totalShares: 8_926_759_580_492_877_835_961_310_684_912n }

  it('stake mints amount × shares / staked, rounded down', () => {
    expect(sharesForNear(NEAR, totals)).toBe((NEAR * totals.totalShares) / totals.totalStaked)
    expect(sharesForNear(NEAR, { totalStaked: 0n, totalShares: 0n })).toBe(0n)
  })

  it('an unstake of nearForShares(x) never burns more than x, for any x', () => {
    for (const x of [1n, 7n, 10n ** 18n, 123_456_789_012_345_678_901_234n, 3n * NEAR + 1n, totals.totalShares]) {
      const near = nearForShares(x, totals)
      const burnt = (near * totals.totalShares + totals.totalStaked - 1n) / totals.totalStaked
      expect(burnt <= x, String(x)).toBe(true)
      // …and is the closest such value: one more yocto would burn more than x (or exactly x when rounding allows).
      const more = ((near + 1n) * totals.totalShares + totals.totalStaked - 1n) / totals.totalStaked
      expect(more >= x).toBe(true)
    }
  })

  it('value at the 1e24-scaled price, rounded down', () => {
    expect(valueAtPrice(2n * NEAR, 1_430_129_795_786_449_767_244_775n)).toBe(2_860_259_591_572_899_534_489_550n)
    expect(valueAtPrice(1n, 1_430_129_795_786_449_767_244_775n)).toBe(1n)
  })
})

describe('APR from two prices', () => {
  it('1 % over a year is 1 %; over half a year 2 %', () => {
    expect(aprFromPrices(NEAR, (NEAR * 101n) / 100n, 0, YEAR_MS)).toBeCloseTo(1, 9)
    expect(aprFromPrices(NEAR, (NEAR * 101n) / 100n, 0, YEAR_MS / 2)).toBeCloseTo(2, 9)
  })

  it('the 2026-11-08 LiNEAR figures: 1.428877 → 1.430129 over 7 days ≈ 4.57 % (simple)', () => {
    const p0 = 1_428_877_000_000_000_000_000_000n, p1 = 1_430_129_000_000_000_000_000_000n
    expect(aprFromPrices(p0, p1, 0, 7 * 86_400_000)).toBeCloseTo(((1_430_129 / 1_428_877 - 1) * 365.25 / 7) * 100, 6)
  })

  it('stays exact with prices far above 2^53 and returns 0 without a span or a price', () => {
    const p0 = 10n ** 30n, p1 = 10n ** 30n + 10n ** 27n
    expect(aprFromPrices(p0, p1, 1_000, 1_000 + YEAR_MS)).toBeCloseTo(0.1, 9)
    expect(aprFromPrices(p0, p1, 5, 5)).toBe(0)
    expect(aprFromPrices(0n, p1, 0, YEAR_MS)).toBe(0)
    expect(aprFromPrices(p1, p0, 0, YEAR_MS)).toBeLessThan(0) // a falling price is reported as it is
  })
})

describe('epoch clock', () => {
  it('a skipped first height reads the next block for the start time', async () => {
    const node = new FakeNear()
    node.skipped.add(node.epochStart)
    node.skipped.add(node.epochStart + 1n)
    const e = await readEpoch(new NearRpc(node.fetch))
    expect(e.startedAt).toBe(node.timeAt(node.epochStart + 2n))
    expect(e.height).toBe(EPOCH)
  })

  it('a pruned previous epoch falls back to the typical duration; a pruned start is estimated from the head', async () => {
    const node = new FakeNear()
    node.prunedBelow = node.epochStart
    expect((await readEpoch(new NearRpc(node.fetch))).epochMs).toBe(TYPICAL_EPOCH_MS)
    node.prunedBelow = node.epochStart + 20n // past the 10 heights tried after a missing one
    const e = await readEpoch(new NearRpc(node.fetch))
    expect(e.startedAt).toBe(Math.round(node.timeAt(node.head) - 10_000 * (TYPICAL_EPOCH_MS / 43_200)))
  })

  it('past epochs count from the start, future ones from the measured end', async () => {
    const e = await readEpoch(new NearRpc(new FakeNear().fetch))
    const ms = Number(EPOCH_LEN) * MS_PER_BLOCK
    expect(epochStartsAt(e, EPOCH)).toBe(e.startedAt)
    expect(epochStartsAt(e, EPOCH - 2n)).toBe(e.startedAt - 2 * ms)
    expect(epochStartsAt(e, EPOCH + 1n)).toBe(e.endsAt)
    expect(epochStartsAt(e, EPOCH + 4n)).toBe(e.endsAt + 3 * ms)
  })
})
