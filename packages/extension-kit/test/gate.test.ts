import { describe, expect, it } from 'vitest'
import { ReviewGate, evmCallMatcher } from '../src/index.js'

const A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const B = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'

describe('ReviewGate', () => {
  it('each pre-approval passes exactly one matching operation, within its ttl', () => {
    let t = 1_000
    const gate = new ReviewGate(() => t)
    gate.preApprove([evmCallMatcher({ caip2: 'eip155:1', to: A, data: '0xa9059cbb', value: 0n }), evmCallMatcher({ caip2: 'eip155:1', to: B, value: 5n })], 60_000)
    expect(gate.pending).toBe(2)
    expect(gate.consume({ kind: 'evm-tx', caip2: 'eip155:1', to: A.toLowerCase(), data: '0xA9059CBB', value: 0n })).toBe(true)
    expect(gate.consume({ kind: 'evm-tx', caip2: 'eip155:1', to: A, data: '0xa9059cbb', value: 0n })).toBe(false) // spent
    expect(gate.consume({ kind: 'evm-tx', caip2: 'eip155:8453', to: B, value: 5n })).toBe(false) // other chain
    expect(gate.consume({ kind: 'evm-tx', caip2: 'eip155:1', to: B, value: 6n })).toBe(false) // other value
    expect(gate.consume({ kind: 'evm-tx', caip2: 'eip155:1', to: B, data: '0x', value: 5n })).toBe(true) // '0x' = no data
    expect(gate.pending).toBe(0)
    gate.preApprove([evmCallMatcher({ caip2: 'eip155:1', to: B, value: 1n })], 10)
    t += 11
    expect(gate.consume({ kind: 'evm-tx', caip2: 'eip155:1', to: B, value: 1n })).toBe(false) // expired
    gate.preApprove([(op) => op.kind === 'solana-serialized'])
    expect(gate.consume({ kind: 'solana-serialized', serializedTx: 'AQ==' })).toBe(true)
    gate.preApprove([() => true])
    gate.clear()
    expect(gate.consume({ kind: 'evm-typed-data', caip2: 'eip155:1' })).toBe(false)
  })
})
