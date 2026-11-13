// A dry auction before a wallet is connected (no sender): LI.FI's quote is priced for a placeholder and carries no
// transaction, so its native bridge fee rides in providerData.nativeFee — the router's usdValue nets it out, and a LI.FI
// route with a fee is no longer ranked on its gross output. The LI.FI answer is the recorded live one (2026-11-13, Base
// USDC → Arbitrum USDC through Stargate V2, keyless li.quest/v1/quote); nothing is signed or sent.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CrossChainRouter, usdValue, quoteValues, type CrossChainProvider, type QuoteParams } from '@anywalletkit/protocol-swap2-router'
import { lifiProvider } from '@anywalletkit/protocol-swap2-lifi/provider'

afterEach(() => vi.unstubAllGlobals())

type Answer = { action: object; transactionRequest: { value: string } }
const fixture = JSON.parse(readFileSync(new URL('../../../packages/protocol-swap2-lifi/tests/fixtures-live-2026-11-13-evm-intents.json', import.meta.url), 'utf8')) as {
  priceOnly: { params: QuoteParams; response: Answer & { estimate: { toAmountMin: string } } }
}
const { params, response } = fixture.priceOnly
const PRICES = { ETH: 3000, USDC: 1 }

/** Another venue for the same request that delivers a little less, with no fee on top. */
const plain = (minDest: bigint): CrossChainProvider => ({
  name: 'plain', enabled: () => true, supportsRoute: () => true,
  getQuote: async (p) => ({
    provider: 'plain', intentId: 'plain', depositAddress: '', depositMemo: null, sourceAmount: p.amountIn, destAmount: minDest.toString(), minDestAmount: minDest.toString(),
    feeUsd: 0, etaSeconds: 60, reliability: 0.97, validUntilMs: Date.now() + 60_000,
  }),
  buildDeposit: async () => { throw new Error('not built here') },
  trackIntent: async () => ({ state: 'pending' }),
})

describe('LI.FI price-only quote in the router (dry, no sender)', () => {
  it('is valued net of the native fee it declares, and a fee-free route that delivers a little less wins', async () => {
    vi.stubGlobal('fetch', async (u: URL | string) => {
      const url = new URL(String(u))
      return new Response(JSON.stringify({ ...response, action: { ...response.action, slippage: Number(url.searchParams.get('slippage')) } }))
    })
    expect(params.refundAddress).toBeUndefined()
    const minDest = BigInt(response.estimate.toAmountMin)
    const fee = BigInt(response.transactionRequest.value) // Stargate V2, USDC in: the whole value is LayerZero's fee
    // The fee-free venue delivers $1 less than LI.FI's minimum; LI.FI's fee is ~$1.93 at ETH $3000.
    const router = new CrossChainRouter([lifiProvider({}), plain(minDest - 1_000_000n)], { valueUsd: usdValue(PRICES) })
    const set = (await router.getQuotes(params))!
    const lifi = set.quotes.find((q) => q.provider === 'lifi')!
    expect(lifi.txRequest).toBeUndefined()
    expect(lifi.providerData).toEqual({ placeholder: 'sender', nativeFee: fee.toString() })
    const gross = Number(minDest) / 1e6
    const feeUsd = (Number(fee) / 1e18) * PRICES.ETH
    expect(feeUsd).toBeGreaterThan(1)
    expect(lifi.netValueUsd).toBeCloseTo(gross - feeUsd, 6)
    expect(set.best.provider).toBe('plain')
    // The value information the wallet shows agrees: LI.FI delivers its output less the fee.
    const values = quoteValues(PRICES, params, set.quotes)
    expect(values.find((v) => v.provider === 'lifi')!.valueUsdOut).toBeCloseTo(Number(BigInt((lifi as { destAmount: string }).destAmount)) / 1e6 - feeUsd, 6)
  })
})
