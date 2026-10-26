import { describe, expect, it } from 'vitest'
import { memoryJsonStorage, type TokensState } from '@anywalletkit/tokens'
import type { CrossChainProvider, QuoteParams } from '@anywalletkit/protocol-swap2-core'
import type { TokenInfo } from '@anywalletkit/core'
import { confirmAdd, lookUp, openTokens, sellRoutes, swapsForUserTokens, userRows } from '../src/custom-tokens.ts'
import { tokenList } from '../src/balances.ts'

const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const SELF = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'
/** An Ethereum read-only account stand-in that reads PEPE's token info. */
const account = {
  chain: 'eip155:1',
  getAddress: async () => SELF,
  getChainId: async () => 1,
  getTokenInfo: async (address: string): Promise<TokenInfo> => {
    if (address.toLowerCase() !== PEPE.toLowerCase()) throw new Error('not a token')
    return { address: PEPE, standard: 'erc20', decimals: 18, symbol: 'PEPE', name: 'Pepe', totalSupply: 10n ** 30n, flags: [] }
  },
}

describe('Custom tokens guide (docs) — offline', () => {
  it('look up → warnings → add → shows on the balances screen; catalog tokens are not added twice', async () => {
    const found = await lookUp(account as never, PEPE)
    if (found.listed) throw new Error('PEPE is not in the catalog')
    expect(found.assessment.risks.map((r) => r.code)).toEqual(['unlisted'])
    const tokens = await openTokens(memoryJsonStorage<TokensState>())
    await confirmAdd(tokens, found)
    expect((await lookUp(account as never, USDC)).listed?.symbol).toBe('USDC')
    const rows = tokenList('eip155:1', userRows(tokens, 'eip155:1'))
    expect(rows.at(-1)).toMatchObject({ token: PEPE, symbol: 'PEPE', decimals: 18, source: 'user' })
  })

  it('sells a user token through providers that take any token', async () => {
    const seen: QuoteParams[] = []
    const open: CrossChainProvider = {
      name: 'open', enabled: () => true, supportsRoute: () => true, supportsSameChain: true,
      getQuote: async (params) => {
        seen.push(params)
        return { provider: 'open', intentId: 'i', depositAddress: '', depositMemo: null, sourceAmount: params.amountIn, destAmount: '43000000', minDestAmount: '42500000', feeUsd: 0, etaSeconds: 5, reliability: 1, validUntilMs: Date.now() + 60_000, txRequest: { to: SELF, data: '0x', value: '0', chainId: 1 } }
      },
      buildDeposit: async () => { throw new Error('quote only') },
      trackIntent: async () => ({ state: 'pending' }),
    }
    const tokens = await openTokens(memoryJsonStorage<TokensState>())
    const found = await lookUp(account as never, PEPE)
    const pepe = (await confirmAdd(tokens, found))!
    const routes = await sellRoutes(swapsForUserTokens(account as never, 'eip155:1', [open]), pepe, 10_000_000n * 10n ** 18n, 'USDC')
    expect(routes.map((r) => [r.provider, r.quote.toTokenAmount])).toEqual([['open', 43_000_000n]])
    expect(seen[0]).toMatchObject({ sourceToken: PEPE, sourceDecimals: 18 })
  })
})
