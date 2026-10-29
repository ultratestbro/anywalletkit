// Scan 2026-10-28, F4/F5: a market configured by id took its MarketParams from the RPC's
// idToMarketParams without hashing them, and Morpho picks the market from the params in the
// calldata, so a hostile RPC sent the supply to its own market. The answer must hash to the id.
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { MorphoMarketProtocolEvm, marketId } from '../src/index.js'
import { MORPHO_ABI, ORACLE_ABI } from '../src/abi.js'
import { CBBTC, E6, E8, IRM, MARKET_ID, MORPHO, PARAMS, USDC, account, makeMorpho } from './fixture.js'

const ATTACKER_ORACLE = getAddress('0x00000000000000000000000000000000BadBad01')
const ATTACKER = { loanToken: USDC, collateralToken: CBBTC, oracle: ATTACKER_ORACLE, irm: IRM, lltv: 945000000000000000n }

/** The only lie: idToMarketParams(real id) answers the attacker market's params; every other read is honest. */
const hostile = () => {
  const { chain } = makeMorpho()
  const real = chain.contracts.get(MORPHO.toLowerCase())!
  chain.on(MORPHO, MORPHO_ABI, (fn, args, ctx) => {
    if (fn === 'idToMarketParams' && (args[0] as string).toLowerCase() === MARKET_ID) return [ATTACKER.loanToken, ATTACKER.collateralToken, ATTACKER.oracle, ATTACKER.irm, ATTACKER.lltv]
    return real.handler(fn, args, ctx)
  })
  chain.on(ATTACKER_ORACLE, ORACLE_ABI, () => 100_000n * 10n ** 36n * E6 / E8)
  return chain
}

describe('F4 / F5: an id-configured market refuses RPC params that do not hash to the id', () => {
  it('supply, supplyCollateral, borrow and the reads are refused before anything is sent', async () => {
    expect(marketId(ATTACKER)).not.toBe(MARKET_ID)
    const chain = hostile()
    const acc = account()
    const p = new MorphoMarketProtocolEvm(acc, { chainId: 8453, market: MARKET_ID, provider: chain.provider, api: null })
    for (const call of [() => p.supply({ amount: 100n * E6 }), () => p.supplyCollateral({ amount: E8 }), () => p.borrow({ amount: E6 }), () => p.quoteSupply({ amount: E6 }), () => p.getMarket()]) {
      await expect(call()).rejects.toThrow(/hash to 0x[0-9a-f]{64} .*refusing them/)
    }
    expect(acc.sent).toHaveLength(0)
  })

  it('the real market by id, whose params hash to it, keeps working', async () => {
    const { chain } = makeMorpho()
    expect(marketId(PARAMS)).toBe(MARKET_ID)
    const acc = account()
    const p = new MorphoMarketProtocolEvm(acc, { chainId: 8453, market: MARKET_ID, provider: chain.provider, api: null })
    await expect(p.supply({ amount: 100n * E6 })).resolves.toBeDefined()
    expect(acc.sent.length).toBeGreaterThan(0)
  })
})
