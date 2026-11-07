import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { LiquidStakingError, LiquidStakingProtocolNear, poolRequestId, resolvePool } from '../src/index.js'

// Contract helpers the module and the app share (NEAR-STAKING-API.md). Protocol methods are covered
// by protocol.test.ts / conformance.test.ts once implemented.

const near = (chain = 'near:mainnet') => createMockAccount({ chain, address: 'alice.near' })

describe('config', () => {
  it('requires a known preset or a pinned custom contract', () => {
    expect(() => new LiquidStakingProtocolNear(near(), {} as never)).toThrow(LiquidStakingError)
    expect(() => new LiquidStakingProtocolNear(near(), { pool: 'stnear' as never })).toThrow(/Unknown pool/)
    expect(() => new LiquidStakingProtocolNear(near(), { pool: { contract: 'x.near', symbol: 'X', codeHashes: [] } })).toThrow(/codeHashes/)
    expect(new LiquidStakingProtocolNear(near(), { pool: 'rnear' }).pool.contract).toBe('lst.rhealab.near')
  })

  it('resolves presets per network; rNEAR has no testnet contract', () => {
    expect(resolvePool('linear', 'mainnet').contract).toBe('linear-protocol.near')
    expect(resolvePool('linear', 'testnet').contract).toBe('linear-protocol.testnet')
    expect(() => resolvePool('rnear', 'testnet')).toThrow(/no contract on NEAR testnet/)
    expect(new LiquidStakingProtocolNear(near('near:testnet'), { pool: 'linear' }).pool.contract).toBe('linear-protocol.testnet')
  })
})

describe('poolRequestId', () => {
  it('is the first 8 bytes of sha256(contract) as a u64', () => {
    const c = 'linear-protocol.near'
    expect(poolRequestId(c)).toBe(BigInt(`0x${createHash('sha256').update(c).digest('hex').slice(0, 16)}`))
  })
})
