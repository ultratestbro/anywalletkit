// Watch 2026-11-04, sdks-dead-deposit-rule: Morpho's SDK (morpho-sdk 9.2.0) refuses a supply or
// deposit into a market or vault without a dead deposit at 0x…dEaD — MIN_DEAD_SHARES = 1e9
// shares, and for a Vault V2 also MIN_VAULT_V2_DEAD_ASSETS = 1e6 assets and a share price above
// 1 / (10 × virtualShares). A nearly empty target without one can have its share price inflated
// against the next depositor. Our supply paths sent plain deposit / supply calls. Now they read
// the rule first and refuse (MorphoDeadDepositError, code InsufficientDeadDeposit) unless the
// config passes allowWithoutDeadDeposit; withdrawals and the other market writes are not gated.
import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { ERC4626_ABI, VAULT_V2_ABI } from '../src/abi.js'
import {
  DEAD_ADDRESS, MIN_DEAD_SHARES, MIN_VAULT_V2_DEAD_ASSETS, MorphoDeadDepositError, MorphoError, MorphoMarketProtocolEvm, MorphoVaultProtocolEvm, evaluateDeadDeposit,
} from '../src/index.js'
import { DEAD, DEAD_SUPPLY_SHARES, DEAD_VAULT_SHARES, E6, E8, E18, FAKE_VAULT, MARKET_ID, MORPHO, USER, VAULT, VAULT_V2, account, makeMorpho, setBalance, setPosition } from './fixture.js'

const key = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join(':')
const setup = (opts: { allow?: boolean } = {}) => {
  const { chain, state } = makeMorpho()
  const acc = account()
  const extra = opts.allow ? { allowWithoutDeadDeposit: true } : {}
  const cfg = { chainId: 8453, provider: chain.provider, api: null, ...extra }
  return {
    chain, state, acc,
    market: new MorphoMarketProtocolEvm(acc, { ...cfg, market: MARKET_ID }),
    v1: new MorphoVaultProtocolEvm(acc, { ...cfg, vault: VAULT }),
    v2: new MorphoVaultProtocolEvm(acc, { ...cfg, vault: VAULT_V2 }),
  }
}
const deadReads = (chain: ReturnType<typeof makeMorpho>['chain']) =>
  chain.calls.filter((c) => (c.fn === 'position' || c.fn === 'balanceOf') && (c.args[c.fn === 'position' ? 1 : 0] as string).toLowerCase() === DEAD.toLowerCase())

describe('dead-deposit rule: thresholds mirror morpho-sdk 9.2.0', () => {
  it('constants and the pure evaluation', () => {
    expect(DEAD_ADDRESS).toBe('0x000000000000000000000000000000000000dEaD')
    expect(MIN_DEAD_SHARES).toBe(1_000_000_000n)
    expect(MIN_VAULT_V2_DEAD_ASSETS).toBe(1_000_000n)
    expect(evaluateDeadDeposit(MIN_DEAD_SHARES)).toEqual({ deadShares: MIN_DEAD_SHARES, deadAssets: null, ok: true, failure: null })
    expect(evaluateDeadDeposit(MIN_DEAD_SHARES - 1n).failure).toEqual({ reason: 'deadShares', observed: MIN_DEAD_SHARES - 1n, required: MIN_DEAD_SHARES })
    const v2 = { deadAssets: MIN_VAULT_V2_DEAD_ASSETS, totalAssets: 10n ** 12n, totalSupply: 10n ** 24n, virtualShares: 10n ** 12n }
    expect(evaluateDeadDeposit(MIN_DEAD_SHARES, v2).ok).toBe(true)
    expect(evaluateDeadDeposit(MIN_DEAD_SHARES, { ...v2, deadAssets: MIN_VAULT_V2_DEAD_ASSETS - 1n }).failure?.reason).toBe('deadAssets')
    // (0 + 1) × 10 × 1e12 = 1e13 ≤ 9e12 + 1e12: at the bound the price counts as deflated.
    expect(evaluateDeadDeposit(MIN_DEAD_SHARES, { ...v2, totalAssets: 0n, totalSupply: 9n * 10n ** 12n }).failure)
      .toEqual({ reason: 'sharePrice', observed: 10n ** 13n, required: 10n ** 13n + 1n })
    expect(evaluateDeadDeposit(MIN_DEAD_SHARES, { ...v2, totalAssets: 0n, totalSupply: 9n * 10n ** 12n - 1n }).ok).toBe(true)
    // The shares rule is checked first, like the reference.
    expect(evaluateDeadDeposit(0n, { ...v2, deadAssets: 0n }).failure?.reason).toBe('deadShares')
  })
})

describe('dead-deposit rule: market supply', () => {
  it('reads Morpho.position(id, 0x…dEaD) and passes a seeded market', async () => {
    const { market } = setup()
    expect(await market.getDeadDeposit()).toEqual({ deadShares: DEAD_SUPPLY_SHARES, deadAssets: null, ok: true, failure: null })
  })

  it('a market without a dead deposit is refused before any approval; the boundary is 1e9 shares', async () => {
    const { market, state, acc } = setup()
    state.positions.delete(DEAD.toLowerCase())
    const e = await market.supply({ amount: 100n * E6 }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(MorphoDeadDepositError)
    expect(e).toBeInstanceOf(MorphoError)
    expect(e).toMatchObject({ code: 'InsufficientDeadDeposit', reason: 'deadShares', observed: 0n, required: MIN_DEAD_SHARES, target: MARKET_ID })
    expect((e as Error).message).toMatch(/holds 0 dead shares at 0x000000000000000000000000000000000000dEaD, below the required 1000000000.*allowWithoutDeadDeposit/)
    await expect(market.quoteSupply({ amount: E6 })).rejects.toBeInstanceOf(MorphoDeadDepositError)
    state.positions.set(DEAD.toLowerCase(), { supplyShares: MIN_DEAD_SHARES - 1n, borrowShares: 0n, collateral: 0n })
    await expect(market.supply({ amount: E6 })).rejects.toMatchObject({ observed: MIN_DEAD_SHARES - 1n })
    expect(acc.sent).toHaveLength(0)
    state.positions.set(DEAD.toLowerCase(), { supplyShares: MIN_DEAD_SHARES, borrowShares: 0n, collateral: 0n })
    await market.supply({ amount: E6 })
    expect(acc.sent.length).toBeGreaterThan(0)
  })

  it('allowWithoutDeadDeposit supplies without reading the rule', async () => {
    const { market, state, acc, chain } = setup({ allow: true })
    state.positions.delete(DEAD.toLowerCase())
    await market.supply({ amount: 100n * E6 })
    expect(acc.sent).toHaveLength(2)
    expect(deadReads(chain)).toHaveLength(0)
  })

  it('withdraw, collateral, borrow and repay are never gated by it', async () => {
    const { market, state, acc } = setup()
    state.positions.delete(DEAD.toLowerCase())
    setPosition(state, USER, { supplyAssets: 1_000n * E6, collateral: E8 })
    await market.withdraw({ amount: 'max' })
    await market.supplyCollateral({ amount: E8 })
    await market.borrow({ amount: 10_000n * E6 })
    setPosition(state, USER, { borrowAssets: 1_000n * E6, collateral: E8 })
    await market.repay({ amount: 100n * E6 })
    await market.withdrawCollateral({ amount: E8 / 10n })
    expect(acc.sent.length).toBeGreaterThanOrEqual(5)
  })

  it('a failed read is not a pass: the error propagates and nothing is sent', async () => {
    const { market, chain, acc } = setup()
    const morpho = chain.contracts.get(MORPHO.toLowerCase())!
    const real = morpho.handler
    morpho.handler = (fn, args, ctx) => {
      if (fn === 'position' && (args[1] as string).toLowerCase() === DEAD.toLowerCase()) throw new Error('rpc down')
      return real(fn, args, ctx)
    }
    await expect(market.supply({ amount: E6 })).rejects.toThrow()
    await expect(market.supply({ amount: E6 })).rejects.not.toBeInstanceOf(MorphoDeadDepositError)
    expect(acc.sent).toHaveLength(0)
  })
})

describe('dead-deposit rule: vault deposit', () => {
  it('V1: balanceOf(0x…dEaD) ≥ 1e9 shares; refused below, opt-in proceeds, withdrawals untouched', async () => {
    const { v1, state, acc } = setup()
    expect(await v1.getDeadDeposit()).toMatchObject({ deadShares: DEAD_VAULT_SHARES, deadAssets: null, ok: true })
    state.balances.set(key(VAULT, DEAD), MIN_DEAD_SHARES - 1n)
    const e = await v1.supply({ amount: 100n * E6 }).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'InsufficientDeadDeposit', reason: 'deadShares', observed: MIN_DEAD_SHARES - 1n, required: MIN_DEAD_SHARES, target: VAULT })
    expect((e as Error).message).toMatch(/^Gauntlet USDC Prime: .*Choose another vault/)
    await expect(v1.quoteSupply({ amount: E6 })).rejects.toBeInstanceOf(MorphoDeadDepositError)
    expect(acc.sent).toHaveLength(0)
    setBalance(state, VAULT, USER, 100n * E18)
    await v1.withdraw({ amount: 40n * E6 })
    await v1.withdraw({ amount: 'max' })
    expect(acc.sent).toHaveLength(2)

    const allowed = setup({ allow: true })
    allowed.state.balances.delete(key(VAULT, DEAD))
    await allowed.v1.supply({ amount: 100n * E6 })
    expect(allowed.acc.sent).toHaveLength(2)
    expect(deadReads(allowed.chain)).toHaveLength(0)
  })

  it('V2: dead shares, dead assets ≥ 1e6 and the share price are all checked', async () => {
    const ok = setup()
    expect(await ok.v2.getDeadDeposit()).toEqual({ deadShares: DEAD_VAULT_SHARES, deadAssets: E6, ok: true, failure: null })
    await ok.v2.supply({ amount: 100n * E6 })
    expect(ok.acc.sent).toHaveLength(2)

    // Enough dead shares, but worth 0.5 USDC: like the cbBTC V2 vaults whose dead shares are worth a few sats.
    const cheap = setup()
    cheap.state.balances.set(key(VAULT_V2, DEAD), DEAD_VAULT_SHARES / 2n)
    await expect(cheap.v2.supply({ amount: 100n * E6 })).rejects.toMatchObject({
      code: 'InsufficientDeadDeposit', reason: 'deadAssets', observed: E6 / 2n, required: MIN_VAULT_V2_DEAD_ASSETS,
    })
    expect(cheap.acc.sent).toHaveLength(0)

    // Stored _totalAssets deflated to 0 while convertToAssets still answers: the share-price rule trips.
    const deflated = setup()
    const v2c = deflated.chain.contracts.get(VAULT_V2.toLowerCase())!
    const real = v2c.handler
    v2c.handler = (fn, args, ctx) => (fn === '_totalAssets' ? 0n : real(fn, args, ctx))
    const e = await deflated.v2.supply({ amount: 100n * E6 }).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'InsufficientDeadDeposit', reason: 'sharePrice', observed: 10n ** 13n })
    expect((e as Error).message).toMatch(/share price is at or below 1 \/ \(10 × virtualShares\)/)
    expect(deflated.acc.sent).toHaveLength(0)

    // Withdrawals out of a V2 vault without any dead deposit still go through.
    const exit = setup()
    exit.state.balances.delete(key(VAULT_V2, DEAD))
    setBalance(exit.state, VAULT_V2, USER, 100n * E18)
    await exit.v2.withdraw({ amount: 'max' })
    expect(exit.acc.sent).toHaveLength(1)
  })

  it('V2 reads _totalAssets and virtualShares from the vault', async () => {
    const { v2, chain } = setup()
    await v2.getDeadDeposit()
    const fns = chain.calls.filter((c) => c.to === VAULT_V2).map((c) => c.fn)
    expect(fns).toEqual(expect.arrayContaining(['balanceOf', 'convertToAssets', '_totalAssets', 'totalSupply', 'virtualShares']))
    expect(VAULT_V2_ABI.some((x) => x.name === '_totalAssets')).toBe(true)
    expect(ERC4626_ABI.some((x) => x.name === 'balanceOf')).toBe(true)
  })

  it('an unverified vault the caller opted into gets the shares rule, read from that vault', async () => {
    const { chain, state } = makeMorpho()
    const acc = createMockAccount({ chain: 'eip155:8453', address: USER })
    const p = new MorphoVaultProtocolEvm(acc, { chainId: 8453, vault: FAKE_VAULT, provider: chain.provider, api: null, allowUnverifiedVault: true })
    // VAULT is seeded with a passing dead deposit; the look-alike has its own, distinct balances.
    expect(state.balances.get(key(VAULT, DEAD))).toBe(DEAD_VAULT_SHARES)
    expect(await p.getDeadDeposit()).toMatchObject({ deadShares: 0n, deadAssets: null, ok: false, failure: { reason: 'deadShares', observed: 0n } })
    await expect(p.supply({ amount: E6 })).rejects.toMatchObject({ code: 'InsufficientDeadDeposit', target: FAKE_VAULT })
    expect(acc.sent).toHaveLength(0)
    setBalance(state, FAKE_VAULT, DEAD, MIN_DEAD_SHARES + 7n)
    expect(await p.getDeadDeposit()).toMatchObject({ deadShares: MIN_DEAD_SHARES + 7n, ok: true })
    const reads = deadReads(chain)
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((c) => c.to === FAKE_VAULT)).toBe(true)
  })

  it('planSupply evaluates the rule on the state it already read: one dead read, no second vault description', async () => {
    const { v1, v2, market, chain } = setup()
    await v1.getVault(); await v2.getVault(); await market.getMarket()
    const before = chain.calls.length
    await v1.quoteSupply({ amount: E6 }); await v2.quoteSupply({ amount: E6 }); await market.quoteSupply({ amount: E6 })
    const during = chain.calls.slice(before)
    expect(deadReads({ calls: during } as unknown as ReturnType<typeof makeMorpho>['chain'])).toHaveLength(3)
    // getVault / resolve would re-read asset(), the factories and idToMarketParams.
    expect(during.filter((c) => c.fn === 'asset' || c.fn === 'isMetaMorpho' || c.fn === 'isVaultV2' || c.fn === 'idToMarketParams')).toHaveLength(0)
  })
})
