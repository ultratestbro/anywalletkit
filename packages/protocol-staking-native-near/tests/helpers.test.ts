import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { NativeStakingProtocolNear, NearStakingError, factoryOf, poolRequestId, sameTransactions } from '../src/index.js'

// Contract helpers that the module and the app share (NEAR-STAKING-API.md). The protocol methods are
// covered by protocol.test.ts and conformance.test.ts.

const near = () => createMockAccount({ chain: 'near:mainnet', address: 'alice.near' })

describe('config', () => {
  it('requires pools, validates ids, picks the single pool as default', () => {
    expect(() => new NativeStakingProtocolNear(near(), {} as never)).toThrow(NearStakingError)
    expect(() => new NativeStakingProtocolNear(near(), { pools: ['NOT VALID'] })).toThrow(/valid NEAR account id/)
    const p = new NativeStakingProtocolNear(near(), { pools: ['astro-stakers.poolv1.near', 'astro-stakers.poolv1.near'] })
    expect(p.pools).toEqual([{ id: 'astro-stakers.poolv1.near' }])
    expect(p.defaultPool).toBe('astro-stakers.poolv1.near')
    expect(() => new NativeStakingProtocolNear(near(), { pools: ['a.poolv1.near'], defaultPool: 'b.poolv1.near' })).toThrow(/defaultPool/)
    expect(() => new NativeStakingProtocolNear(near(), { pools: 'any', maxFee: 101 })).toThrow(/maxFee/)
  })

  it('follows the account chain unless the network is pinned', () => {
    expect(new NativeStakingProtocolNear(near(), { pools: 'any' }).network).toBe('mainnet')
    expect(new NativeStakingProtocolNear(createMockAccount({ chain: 'near:testnet', address: 'bob.testnet' }), { pools: 'any' }).network).toBe('testnet')
    expect(new NativeStakingProtocolNear(near(), { pools: 'any', network: 'testnet' }).network).toBe('testnet')
  })
})

describe('factoryOf', () => {
  it('accepts one name segment before a factory suffix, per network', () => {
    expect(factoryOf('astro-stakers.poolv1.near', 'mainnet')).toBe('poolv1')
    expect(factoryOf('aurora.pool.near', 'mainnet')).toBe('pool')
    expect(factoryOf('kiln.pool.f863973.m0', 'testnet')).toBe('testnet')
    expect(factoryOf('lst-pool.near', 'mainnet')).toBeNull()      // in the validator set, not a factory pool
    expect(factoryOf('meta-pool.near', 'mainnet')).toBeNull()     // lockup-whitelisted, not a pool
    expect(factoryOf('a.b.poolv1.near', 'mainnet')).toBeNull()
    expect(factoryOf('.poolv1.near', 'mainnet')).toBeNull()
    expect(factoryOf('kiln.pool.f863973.m0', 'mainnet')).toBeNull()
    expect(factoryOf('astro-stakers.poolv1.near', 'testnet')).toBeNull()
  })
})

describe('poolRequestId', () => {
  it('is the first 8 bytes of sha256(pool id) as a u64', () => {
    const id = 'astro-stakers.poolv1.near'
    const expected = BigInt(`0x${createHash('sha256').update(id).digest('hex').slice(0, 16)}`)
    expect(poolRequestId(id)).toBe(expected)
    expect(poolRequestId('zavodil.poolv1.near')).not.toBe(expected)
  })
})

describe('sameTransactions', () => {
  const tx = (deposit: bigint, args: Record<string, unknown> = {}) => [{ receiverId: 'astro-stakers.poolv1.near', actions: [{ functionCall: { methodName: 'deposit_and_stake', args, gas: 50n * 10n ** 12n, deposit } }] }]
  it('compares receivers, methods, args (key order ignored), gas and deposits', () => {
    expect(sameTransactions(tx(1n, { a: 1, b: 2 }), tx(1n, { b: 2, a: 1 }))).toBe(true)
    expect(sameTransactions(tx(1n), tx(2n))).toBe(false)
    expect(sameTransactions(tx(1n), [{ ...tx(1n)[0]!, receiverId: 'zavodil.poolv1.near' }])).toBe(false)
    expect(sameTransactions(tx(1n), [])).toBe(false)
  })
})
