// Scan 2026-10-28, F11: a custom addressesProvider without `pool` let the RPC's getPool() name the
// spender of the approval and the permit. The Pool is now always pinned: a custom provider needs
// `pool`, and a preset's provider passed explicitly picks up the shipped Pool.
import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, type Hex } from 'viem'
import { AaveError, AaveProtocolEvm } from '../src/index.js'
import { ADDRESSES_PROVIDER_ABI, ERC20_ABI, POOL_ABI } from '../src/abi.js'
import { ADDRESSES_PROVIDER, E6, POOL, USDT, account, makeMarket, permitAccount } from './fixture.js'

const EVIL = getAddress('0x00000000000000000000000000000000BadBad02')
const CUSTOM = getAddress('0x00000000000000000000000000000000c0ffee01')

/** The RPC reports the attacker's Pool (answering the honest Pool's reads); a custom provider answers like the real one. */
const hostile = () => {
  const { chain } = makeMarket({ poolAddress: EVIL })
  chain.on(EVIL, POOL_ABI, chain.contracts.get(POOL.toLowerCase())!.handler)
  chain.on(CUSTOM, ADDRESSES_PROVIDER_ABI, chain.contracts.get(ADDRESSES_PROVIDER.toLowerCase())!.handler)
  return chain
}
const dec = (t: unknown) => {
  const x = t as { to: string; data: Hex }
  const { functionName, args } = decodeFunctionData({ abi: x.to === POOL || x.to === EVIL ? POOL_ABI : ERC20_ABI, data: x.data })
  return { to: x.to, fn: functionName, args: args as readonly unknown[] }
}

describe('F11: the Pool that gets the approvals is never the RPC\'s word alone', () => {
  it('a custom addressesProvider without `pool` is refused at construction', () => {
    const chain = hostile()
    expect(() => new AaveProtocolEvm(account(), { chainId: 1, addressesProvider: CUSTOM, provider: chain.provider })).toThrow(AaveError)
    expect(() => new AaveProtocolEvm(account(), { chainId: 1, addressesProvider: CUSTOM, provider: chain.provider })).toThrow(/Pass 'pool'/)
  })

  it('the preset\'s provider passed without `pool` takes the shipped Pool: the RPC\'s Pool is refused on approve and permit roads', async () => {
    for (const acc of [account(), permitAccount()]) {
      const p = new AaveProtocolEvm(acc, { chainId: 1, addressesProvider: ADDRESSES_PROVIDER, provider: hostile().provider, reserveTtlMs: 0 })
      await expect(p.supply({ token: USDT, amount: 5n * E6 })).rejects.toThrow(/Pool mismatch/)
      expect(acc.sent).toHaveLength(0)
      expect((acc as { permits?: unknown[] }).permits ?? []).toHaveLength(0)
    }
  })

  it('a custom provider with `pool` refuses a different Pool, and works with the right one', async () => {
    const acc = account()
    const pinned = new AaveProtocolEvm(acc, { chainId: 1, addressesProvider: CUSTOM, pool: POOL, provider: hostile().provider, reserveTtlMs: 0 })
    await expect(pinned.supply({ token: USDT, amount: 5n * E6 })).rejects.toThrow(/Pool mismatch/)
    expect(acc.sent).toHaveLength(0)

    const { chain } = makeMarket()
    chain.on(CUSTOM, ADDRESSES_PROVIDER_ABI, chain.contracts.get(ADDRESSES_PROVIDER.toLowerCase())!.handler)
    const ok = new AaveProtocolEvm(acc, { chainId: 1, addressesProvider: CUSTOM, pool: POOL, provider: chain.provider, reserveTtlMs: 0 })
    await ok.supply({ token: USDT, amount: 5n * E6 })
    expect(acc.sent.map(dec).at(-1)).toMatchObject({ to: POOL, fn: 'supply' })
  })
})
