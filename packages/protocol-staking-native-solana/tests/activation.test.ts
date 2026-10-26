import { describe, expect, it } from 'vitest'
import { activationStatus, settlesAt, statusOf, warmupCooldownRateBps } from '../src/activation.js'
import type { ClusterStake, Delegation } from '../src/codec.js'

// Hand-computed against solana-program/stake `stake_activating_and_deactivating_v2`:
// allowance = account × cluster_effective × rate_bps ÷ (cluster_moving × 10 000), floored, at least 1.

const MAX = 0xffff_ffff_ffff_ffffn
const d = (o: Partial<Delegation>): Delegation => ({ voter: 'v', stake: 50n, activationEpoch: 10n, deactivationEpoch: MAX, ...o })
const entry = (effective: bigint, activating: bigint, deactivating: bigint): ClusterStake => ({ effective, activating, deactivating })

describe('warm-up', () => {
  it('rate: 25 % before the change epoch, 9 % from it (the program pins the change at epoch 0)', () => {
    expect(warmupCooldownRateBps(5n, 10n)).toBe(2500n)
    expect(warmupCooldownRateBps(10n, 10n)).toBe(900n)
    expect(warmupCooldownRateBps(5n, null)).toBe(2500n)
  })

  it('a congested cluster activates a share per epoch', () => {
    // epoch 10: 100 effective, 100 activating → epoch 11: 50·100·900/(100·10 000) = 4.5 → 4
    // epoch 11: 109 effective, 91 activating  → epoch 12: 46·109·900/(91·10 000) = 4.96 → 4 → 8
    const h = new Map([[10n, entry(100n, 100n, 0n)], [11n, entry(109n, 91n, 0n)]])
    expect(activationStatus(d({}), 10n, h, 0n)).toEqual({ effective: 0n, activating: 50n, deactivating: 0n })
    expect(activationStatus(d({}), 11n, h, 0n)).toEqual({ effective: 4n, activating: 46n, deactivating: 0n })
    expect(activationStatus(d({}), 12n, h, 0n)).toEqual({ effective: 8n, activating: 42n, deactivating: 0n })
    // with the old 25 % rate the first step is 50·100·2500/(100·10 000) = 12.5 → 12
    expect(activationStatus(d({}), 11n, h, 20n).effective).toBe(12n)
  })

  it('a calm cluster activates fully at the next boundary; before activation nothing counts', () => {
    const h = new Map([[10n, entry(400_000_000n, 1_000n, 0n)]])
    expect(activationStatus(d({}), 11n, h, 0n)).toEqual({ effective: 50n, activating: 0n, deactivating: 0n })
    expect(activationStatus(d({}), 9n, h, 0n)).toEqual({ effective: 0n, activating: 0n, deactivating: 0n })
  })

  it('older than the history: fully effective; bootstrap stake: always effective', () => {
    expect(activationStatus(d({ activationEpoch: 1n }), 600n, new Map(), 0n).effective).toBe(50n)
    expect(activationStatus(d({ activationEpoch: MAX }), 0n, new Map(), 0n).effective).toBe(50n)
  })
})

describe('cool-down', () => {
  it('deactivating in its own epoch keeps all effective stake cooling; then a share per epoch', () => {
    // active since 1 (out of history), deactivated at 20. Epoch 20: 1000 effective, 200 deactivating.
    // epoch 21: 50·1000·900/(200·10 000) = 22.5 → 22 → 28 left
    // epoch 22: 28·980·900/(150·10 000) = 16.46 → 16 → 12 left
    const h = new Map([[20n, entry(1000n, 0n, 200n)], [21n, entry(980n, 0n, 150n)]])
    const del = d({ activationEpoch: 1n, deactivationEpoch: 20n })
    expect(activationStatus(del, 20n, h, 0n)).toEqual({ effective: 50n, activating: 0n, deactivating: 50n })
    expect(activationStatus(del, 21n, h, 0n)).toEqual({ effective: 28n, activating: 0n, deactivating: 28n })
    expect(activationStatus(del, 22n, h, 0n)).toEqual({ effective: 12n, activating: 0n, deactivating: 12n })
    // Like the program, an epoch with nothing cooling ends the walk (the history says the cool-down is over).
    expect(activationStatus(del, 22n, new Map([[20n, entry(1000n, 0n, 200n)], [21n, entry(980n, 0n, 0n)]]), 0n).deactivating).toBe(28n)
  })

  it('deactivated in its activation epoch: nothing ever took effect', () => {
    expect(activationStatus(d({ activationEpoch: 30n, deactivationEpoch: 30n }), 30n, new Map(), 0n)).toEqual({ effective: 0n, activating: 0n, deactivating: 0n })
  })

  it('older than the history: fully inactive', () => {
    expect(activationStatus(d({ activationEpoch: 1n, deactivationEpoch: 2n }), 600n, new Map(), 0n).effective).toBe(0n)
  })
})

describe('status labels and settling', () => {
  it('labels', () => {
    expect(statusOf(null)).toBe('inactive')
    expect(statusOf({ effective: 0n, activating: 5n, deactivating: 0n })).toBe('activating')
    expect(statusOf({ effective: 5n, activating: 0n, deactivating: 0n })).toBe('active')
    expect(statusOf({ effective: 5n, activating: 0n, deactivating: 5n })).toBe('deactivating')
    expect(statusOf({ effective: 0n, activating: 0n, deactivating: 0n })).toBe('inactive')
  })

  it('settlesAt projects with the latest cluster entry', () => {
    const calm = new Map([[29n, entry(400_000_000n, 1_000n, 1_000n)]])
    expect(settlesAt(d({ activationEpoch: 30n }), 30n, calm, 0n)).toBe(31n)
    expect(settlesAt(d({ activationEpoch: 1n, deactivationEpoch: 30n }), 30n, calm, 0n)).toBe(31n)
    expect(settlesAt(d({ activationEpoch: 1n }), 30n, calm, 0n)).toBe(30n) // already active
    // A tenth of the cluster leaving: 100·1000·900/(100·10 000) = 90 → 10 left at 31, then 9 → 1 left at 32, then 0 (at least 1) at 33.
    const exodus = new Map([[29n, entry(1_000n, 0n, 100n)]])
    const leaving = d({ stake: 100n, activationEpoch: 1n, deactivationEpoch: 30n })
    expect(activationStatus(leaving, 31n, new Map([...exodus, [30n, entry(1_000n, 0n, 100n)]]), 0n).effective).toBe(10n)
    expect(settlesAt(leaving, 30n, exodus, 0n)).toBe(33n)
    expect(settlesAt(leaving, 30n, exodus, 0n, 2)).toBeNull()
  })
})
