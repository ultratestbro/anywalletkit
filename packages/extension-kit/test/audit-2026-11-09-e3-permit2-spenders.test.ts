import { describe, expect, it } from 'vitest'
import { UNISWAP_UNIVERSAL_ROUTERS, permit2KnownSpender } from '@anywalletkit/wallet-evm'
import { DEFAULT_NETWORKS } from '../src/index.js'

// Extension audit 2026-11-09 E3, round two: the Universal Router table in wallet-evm is keyed by chain id.
// Every key has to be a network this kit ships, or the entry is a spender nobody can be asked to sign for.
describe('E3 round two: the pinned Universal Router table against the built-in networks', () => {
  const supported = new Map(DEFAULT_NETWORKS.map((n) => [n.chainId, n.name]))

  it.each(Object.keys(UNISWAP_UNIVERSAL_ROUTERS).map(Number))('chain %i is a built-in network', (chainId) => {
    expect(supported.has(chainId)).toBe(true)
  })

  it.each(Object.entries(UNISWAP_UNIVERSAL_ROUTERS).flatMap(([chain, list]) => list.map((e) => ({ chainId: Number(chain), address: e.address }))))(
    'chain $chainId $address is known on its chain and on no built-in network where it is not listed',
    ({ chainId, address }) => {
      expect(permit2KnownSpender(chainId, address)).toBe('Uniswap Universal Router')
      for (const other of supported.keys()) {
        const listed = (UNISWAP_UNIVERSAL_ROUTERS[other] ?? []).some((e) => e.address.toLowerCase() === address.toLowerCase())
        expect(permit2KnownSpender(other, address) !== undefined).toBe(listed)
      }
    },
  )
})
