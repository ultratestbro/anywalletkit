import { describe, expect, it } from 'vitest'
import { createEvmHistory } from '../src/index.js'
import { ADDRESS } from './helpers.js'

/**
 * Opt-in network check: `LIVE_HISTORY=1 pnpm --filter @forgewallet/history-evm test`.
 * Hits eth.blockscout.com keyless, and Etherscan v2 when ETHERSCAN_API_KEY is set.
 */
const live = process.env['LIVE_HISTORY'] === '1'

describe.skipIf(!live)('live explorers', () => {
  it('Routescan (Ethereum, keyless, default order) answers', async () => {
    const page = await createEvmHistory({ chainId: 1 }).listActivity(ADDRESS, { limit: 5 })
    expect(page.backend).toBe('routescan')
    expect(page.items.length).toBeGreaterThan(0)
  })

  it('Blockscout (Ethereum, keyless): first page merges and paginates', async () => {
    const src = createEvmHistory({ chainId: 1, etherscanCompatUrl: null })
    const page = await src.listActivity(ADDRESS, { limit: 20 })
    expect(page.backend).toBe('blockscout')
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((i) => i.chain === 'eip155:1' && i.time > 1_600_000_000)).toBe(true)
    if (page.cursor) {
      const next = await src.listActivity(ADDRESS, { limit: 20, cursor: page.cursor })
      const minBlock = Math.min(...page.items.map((i) => Number(i.block)))
      for (const it of next.items) expect(Number(it.block)).toBeLessThan(minBlock)
    }
    const tx = await src.getTransaction(page.items[0]!.hash, ADDRESS)
    expect(tx?.hash.toLowerCase()).toBe(page.items[0]!.hash.toLowerCase())
  })

  it.skipIf(!process.env['ETHERSCAN_API_KEY'])('Etherscan v2 (Ethereum, key from env)', async () => {
    const src = createEvmHistory({ chainId: 1, etherscanApiKey: process.env['ETHERSCAN_API_KEY']! })
    const page = await src.listActivity(ADDRESS, { limit: 20 })
    expect(page.backend).toBe('etherscan')
    expect(page.items.length).toBeGreaterThan(0)
    const tx = await src.getTransaction(page.items[0]!.hash, ADDRESS)
    expect(tx?.status).toBe(page.items[0]!.status)
  })

  it('Ink (Blockscout-only chain) answers', async () => {
    const src = createEvmHistory({ chainId: 57073 })
    const page = await src.listActivity(ADDRESS, { limit: 5 })
    expect(page.backend).toBe('blockscout')
    expect(Array.isArray(page.items)).toBe(true)
  })
})
