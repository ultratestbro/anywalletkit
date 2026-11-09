import { describe, expect, it } from 'vitest'
import { EVM_MAINNETS } from '../src/index.js'

// The builtin lists are the ones the extension's DEFAULT_NETWORKS ships: Plasma gained a second operator there
// (extension audit, round two, 2026-11-10 — endpoint checked live against rpc.plasma.to), so it gains it here.
describe('Plasma has a failover endpoint run by a second operator', () => {
  it('rpc.plasma.to first, Tenderly’s public gateway second', () => {
    expect(EVM_MAINNETS.find((n) => n.caip2 === 'eip155:9745')!.rpcs).toEqual(['https://rpc.plasma.to', 'https://plasma.gateway.tenderly.co'])
  })
})
