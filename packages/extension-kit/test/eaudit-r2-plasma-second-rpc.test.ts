import { describe, expect, it } from 'vitest'
import { isPublicHttpsUrl } from '@anywalletkit/networks/url'
import { DEFAULT_NETWORKS } from '../src/index.js'

// Extension audit, round two (2026-11-10): a wallet that asks two independent RPC operators before it acts (Omniston's
// HTLC-secret quorum) could not do so on Plasma — the shipped list had one endpoint. Verified live on 2026-11-10:
// plasma.gateway.tenderly.co answers eth_chainId 0x2611 without a key or a redirect, agrees with rpc.plasma.to on block
// hashes and on the escrow factory's logs, serves state at past blocks, and sends CORS headers.
describe('Plasma ships two RPC endpoints run by different operators', () => {
  const plasma = DEFAULT_NETWORKS.find((n) => n.caip2 === 'eip155:9745')!
  const domain = (url: string) => new URL(url).hostname.split('.').slice(-2).join('.')

  it('the chain’s own RPC stays first; the second is Tenderly’s public gateway', () => {
    expect(plasma.rpcs).toEqual(['https://rpc.plasma.to', 'https://plasma.gateway.tenderly.co'])
    expect(new Set(plasma.rpcs.map(domain)).size).toBe(2)
    expect(plasma.rpcs.every((u) => isPublicHttpsUrl(u))).toBe(true)
  })
})
