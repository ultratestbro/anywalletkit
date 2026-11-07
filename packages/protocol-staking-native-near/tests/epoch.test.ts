import { describe, expect, it } from 'vitest'
import { EPOCH_LENGTH, TYPICAL_EPOCH_MS, epochOfHeight, epochStartsAt, readEpoch } from '../src/index.js'
import { NearRpc } from '@anywalletkit/wallet-near'
import { FakeNear } from './fake-near.js'

const ms = (ns: string) => Number(BigInt(ns) / 1_000_000n)

describe('readEpoch (recorded mainnet answers, 2026-11-08)', () => {
  it('height, start, blocks left, the measured duration of the previous epoch, the estimated end', async () => {
    const node = new FakeNear()
    const { start, prev, final } = node.rec.blocks
    const e = await readEpoch(new NearRpc(node.fetch))
    const epochMs = ms(start.timestamp_nanosec) - ms(prev.timestamp_nanosec)
    const blocksLeft = BigInt(start.height) + EPOCH_LENGTH - BigInt(final.height)
    expect(e).toEqual({
      height: BigInt(node.rec.validators.epoch_height),
      startBlock: BigInt(start.height),
      length: EPOCH_LENGTH,
      block: BigInt(final.height),
      blocksLeft,
      startedAt: ms(start.timestamp_nanosec),
      epochMs,
      endsAt: Math.round(ms(final.timestamp_nanosec) + Number(blocksLeft) * (epochMs / 43_200)),
    })
    // ~6.9 h, not 12 h.
    expect(epochMs / 3.6e6).toBeGreaterThan(6.8)
    expect(epochMs / 3.6e6).toBeLessThan(7)
  })

  it('a skipped first height reads the next produced block', async () => {
    const node = new FakeNear()
    const start = node.rec.blocks.start.height
    node.skipped.add(start)
    node.skipped.add(start + 1)
    const e = await readEpoch(new NearRpc(node.fetch))
    expect(e.startedAt).toBeGreaterThan(ms(node.rec.blocks.start.timestamp_nanosec))
    expect(e.startedAt - ms(node.rec.blocks.start.timestamp_nanosec)).toBeLessThan(2_000)
    expect(node.count('block', (q) => q.block_id === start + 2)).toBe(1)
  })

  it('a pruned previous epoch falls back to the typical duration; a pruned start is estimated from the latest block', async () => {
    const node = new FakeNear()
    node.pruned.add(node.rec.blocks.prev.height)
    const e = await readEpoch(new NearRpc(node.fetch))
    expect(e.epochMs).toBe(TYPICAL_EPOCH_MS)
    const node2 = new FakeNear()
    node2.pruned.add(node2.rec.blocks.start.height)
    const e2 = await readEpoch(new NearRpc(node2.fetch))
    // Heights are not evenly spaced in time (~592 ms each that epoch vs the 575 ms average), so this is minutes off, not hours.
    expect(Math.abs(e2.startedAt - ms(node2.rec.blocks.start.timestamp_nanosec))).toBeLessThan(30 * 60_000)
  })

  it('more than ten skipped heights in a row count as unreadable, not as a wrong block', async () => {
    const node = new FakeNear()
    for (let i = 0; i <= 10; i++) node.skipped.add(node.rec.blocks.prev.height + i)
    expect((await readEpoch(new NearRpc(node.fetch))).epochMs).toBe(TYPICAL_EPOCH_MS)
  })

  it('the latest block must be readable', async () => {
    const node = new FakeNear()
    const rpc = new NearRpc(async (m, p) => { if (m === 'block' && (p as { finality?: string }).finality) throw new Error('down'); return node.fetch(m, p) })
    await expect(readEpoch(rpc)).rejects.toThrow('down')
  })

  it('reuses block times it already read', async () => {
    const node = new FakeNear()
    const blockTimes = new Map<bigint, number>()
    await readEpoch(new NearRpc(node.fetch), { blockTimes })
    const n = node.count('block')
    await readEpoch(new NearRpc(node.fetch), { blockTimes })
    expect(node.count('block') - n).toBe(1) // only the latest block
  })
})

describe('epochStartsAt and epochOfHeight', () => {
  const e = { height: 4946n, startBlock: 223_487_537n, length: EPOCH_LENGTH, block: 223_520_000n, blocksLeft: 0n, startedAt: 1_000_000, epochMs: 24_840_000, endsAt: 0 }
  it('epoch starts are startedAt + Δ × epochMs', () => {
    expect(epochStartsAt(e, 4946n)).toBe(1_000_000)
    expect(epochStartsAt(e, 4950n)).toBe(1_000_000 + 4 * 24_840_000)
    expect(epochStartsAt(e, 4945n)).toBe(1_000_000 - 24_840_000)
  })
  it('heights map to epochs around the boundaries', () => {
    expect(epochOfHeight(e, 223_487_537n)).toBe(4946n)
    expect(epochOfHeight(e, 223_487_536n)).toBe(4945n)
    expect(epochOfHeight(e, 223_444_337n)).toBe(4945n)
    expect(epochOfHeight(e, 223_444_336n)).toBe(4944n)
    expect(epochOfHeight(e, 223_487_537n + 43_199n)).toBe(4946n)
  })
})
