import { describe, expect, it } from 'vitest'
import { EVM_MAINNETS } from '@anywalletkit/networks'
import { DEFAULT_NETWORKS } from '../src/networks.js'

// DEFAULT_NETWORKS is a hand-maintained copy of the EVM rows in @anywalletkit/networks: keep the two in step.
describe('DEFAULT_NETWORKS matches @anywalletkit/networks EVM_MAINNETS', () => {
  const catalog = new Map(EVM_MAINNETS.map((n) => [n.caip2, n]))
  it('every default network has a catalog row with the same name, symbol, RPCs and explorer', () => {
    const drift: string[] = []
    for (const n of DEFAULT_NETWORKS) {
      const c = catalog.get(n.caip2)
      if (!c) { drift.push(`${n.chainId}: not in EVM_MAINNETS`); continue }
      const mine = { caip2: n.caip2, name: n.name, symbol: n.symbol, rpcs: n.rpcs, explorer: n.explorer }
      const theirs = { caip2: c.caip2, name: c.name, symbol: c.symbol, rpcs: c.rpcs, explorer: c.explorer }
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) drift.push(`${n.chainId}: ${JSON.stringify(mine)} != ${JSON.stringify(theirs)}`)
    }
    expect(drift).toEqual([])
  })
  it('every catalog EVM mainnet is a default network', () => {
    const mine = new Set(DEFAULT_NETWORKS.map((n) => n.caip2))
    expect(EVM_MAINNETS.map((n) => n.caip2).filter((id) => !mine.has(id))).toEqual([])
  })
  it('Elysium (99901): HYPE, its one public RPC, explorer root as the link base', () => {
    const ely = DEFAULT_NETWORKS.find((n) => n.chainId === 99901)
    expect(ely).toEqual({ caip2: 'eip155:99901', chainId: 99901, name: 'Elysium', symbol: 'HYPE', rpcs: ['https://rpc.elysium.kinetiq.xyz'], explorer: 'https://elysium.kinetiq.xyz' })
  })
})
