import { describe, expect, it } from 'vitest'
import { NearRpc, WalletAccountReadOnlyNear, type NearTransaction } from '@anywalletkit/wallet-near'
import { GasPricer, MIN_GAS_PURCHASE_PRICE_FALLBACK, costOf } from '../src/index.js'
import { ASTRO, FakeNear, TGAS } from './fake-near.js'

const unstakeAll: NearTransaction = { receiverId: ASTRO, actions: [{ functionCall: { methodName: 'unstake_all', args: {}, gas: 50n * TGAS, deposit: 0n } }] }

describe('fees', () => {
  it('the audit numbers: a 50 Tgas unstake_all held back 0.050919 NEAR on mainnet; upfront covers it, fee is the burnt bound', async () => {
    const node = new FakeNear()
    const prices = await new GasPricer(() => new NearRpc(node.fetch)).prices()
    expect(prices).toEqual({ gasPrice: 110_000_000n, purchasePrice: 1_000_000_000n })
    const { fee, upfront } = costOf([unstakeAll], prices)
    expect(upfront).toBeGreaterThanOrEqual(50_919_000_000_000_000_000_000n)
    expect(upfront).toBeLessThan(56n * 10n ** 21n)
    expect(fee).toBe(WalletAccountReadOnlyNear.gasOf(unstakeAll.actions, false) * 110_000_000n)
  })

  it('caches the protocol config; falls back to the mainnet price, and retries later', async () => {
    const node = new FakeNear()
    node.minGasPurchasePrice = { throws: 'unknown method' }
    const pricer = new GasPricer(() => new NearRpc(node.fetch))
    expect((await pricer.prices()).purchasePrice).toBe(MIN_GAS_PURCHASE_PRICE_FALLBACK)
    expect((await pricer.prices()).purchasePrice).toBe(MIN_GAS_PURCHASE_PRICE_FALLBACK)
    expect(node.count('EXPERIMENTAL_protocol_config')).toBe(1)
    node.minGasPurchasePrice = '7'
    const ok = new GasPricer(() => new NearRpc(node.fetch))
    // below the gas price: the gas price is what is charged
    expect((await ok.prices()).purchasePrice).toBe(110_000_000n)
  })
})
