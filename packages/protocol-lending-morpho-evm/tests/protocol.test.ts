import { describe, expect, it } from 'vitest'
import { decodeFunctionData, toFunctionSelector, type Hex } from 'viem'
import { NotImplementedError, ReadOnlyAccountError } from '@forgewallet/core'
import { createMockAccount } from '@forgewallet/conformance'
import { MorphoApi, MorphoError, MorphoMarketProtocolEvm, MorphoVaultProtocolEvm, accrue, decodeMorphoRevert, marketId, rateToApyPct, toAssetsUp, wTaylorCompounded } from '../src/index.js'
import { ERC20_ABI, ERC4626_ABI, MORPHO_ABI } from '../src/abi.js'
import { MORPHO_CHAINS, MORPHO_CHAIN_IDS } from '../src/chains.js'
import { CBBTC, E6, E8, E18, FAKE_VAULT, MARKET_ID, MORPHO, OTHER, PARAMS, RATE, USDC, USER, VAULT, account, makeMorpho, setAllowance, setBalance, setPosition } from './fixture.js'

const decodeSent = (tx: unknown) => {
  const t = tx as { to: string; data: Hex; value: bigint }
  const abi = t.to === MORPHO ? MORPHO_ABI : t.to === VAULT ? ERC4626_ABI : ERC20_ABI
  const { functionName, args } = decodeFunctionData({ abi, data: t.data })
  return { to: t.to, fn: functionName, args: args as readonly unknown[], value: t.value }
}

const vault = (acc = account()) => {
  const { chain, state } = makeMorpho()
  return { chain, state, acc, p: new MorphoVaultProtocolEvm(acc, { chainId: 8453, vault: VAULT, provider: chain.provider, api: null }) }
}
const market = (acc = account(), cfg: Partial<{ market: unknown }> = {}) => {
  const { chain, state } = makeMorpho()
  return { chain, state, acc, p: new MorphoMarketProtocolEvm(acc, { chainId: 8453, market: (cfg.market ?? MARKET_ID) as never, provider: chain.provider, api: null }) }
}

describe('maths', () => {
  it('derives the live Base cbBTC/USDC market id from its params', () => {
    expect(marketId(PARAMS)).toBe(MARKET_ID)
  })
  it('compounds like MathLib.wTaylorCompounded and accrues like Morpho._accrueInterest', () => {
    const x = 10n ** 9n, n = 1000n
    const first = x * n
    expect(wTaylorCompounded(x, n)).toBe(first + (first * first) / (2n * E18) + ((first * first) / (2n * E18) * first) / (3n * E18))
    const m = { totalSupplyAssets: 1000n * E6, totalSupplyShares: 1000n * E6 * 10n ** 6n, totalBorrowAssets: 500n * E6, totalBorrowShares: 500n * E6 * 10n ** 6n, lastUpdate: 0n, fee: 10n ** 17n }
    const a = accrue(m, RATE, 86_400n)
    expect(a.totalBorrowAssets).toBeGreaterThan(m.totalBorrowAssets)
    expect(a.totalSupplyAssets - m.totalSupplyAssets).toBe(a.totalBorrowAssets - m.totalBorrowAssets)
    expect(a.totalSupplyShares).toBeGreaterThan(m.totalSupplyShares) // fee shares minted
    expect(accrue(m, RATE, 0n)).toEqual(m)
  })
  it('rate → APY (continuous) and debt rounds up', () => {
    expect(rateToApyPct(RATE)).toBeCloseTo(5.127, 2)
    expect(toAssetsUp(1n, 0n, 0n)).toBe(1n)
  })
})

describe('vault', () => {
  it('describes a factory-acknowledged MetaMorpho vault and refuses a look-alike', async () => {
    const { p } = vault()
    const info = await p.getVault()
    expect(info).toMatchObject({ version: 'v1', name: 'Gauntlet USDC Prime', asset: { address: USDC, symbol: 'USDC', decimals: 6 }, fees: { performance: 0.1, management: 0 }, timelockSeconds: 604800 })
    const fake = new MorphoVaultProtocolEvm(account(), { chainId: 8453, vault: FAKE_VAULT, provider: makeMorpho().chain.provider, api: null })
    await expect(fake.getVault()).rejects.toThrow(/not acknowledged by any Morpho vault factory/)
    const allowed = new MorphoVaultProtocolEvm(account(), { chainId: 8453, vault: FAKE_VAULT, provider: makeMorpho().chain.provider, api: null, allowUnverifiedVault: true })
    expect((await allowed.getVault()).version).toBe('unverified')
  })

  it('deposit: exact approve, then deposit to the receiver; token may be omitted; wrong token refused', async () => {
    const { p, acc } = vault()
    const res = await p.supply({ amount: 100n * E6 })
    expect(acc.sent.map(decodeSent)).toMatchObject([
      { to: USDC, fn: 'approve', args: [VAULT, 100n * E6] },
      { to: VAULT, fn: 'deposit', args: [100n * E6, USER] },
    ])
    expect(res.sharesOut).toBeGreaterThan(0n)
    await expect(p.supply({ token: CBBTC, amount: 1n })).rejects.toThrow(/takes USDC/)
    await expect(p.supply({ token: 'native', amount: 1n })).rejects.toThrow(/ERC-20 only/)
  })

  it('respects maxDeposit (caps) before sending', async () => {
    const { p, state, acc } = vault()
    state.vault.maxDeposit = 50n * E6
    await expect(p.supply({ amount: 100n * E6 })).rejects.toThrow(/at most 50000000/)
    state.vault.maxDeposit = 0n
    await expect(p.quoteSupply({ amount: 1n })).rejects.toThrow(/deposits are closed/)
    expect(acc.sent).toHaveLength(0)
  })

  it("withdraw: 'max' redeems every share; partial uses withdraw; liquidity bounds both", async () => {
    const { p, state, acc } = vault()
    setBalance(state, VAULT, USER, 100n * E18)
    const pos = await p.getPosition()
    expect(pos.assets).toBe(100n * E6)
    await p.withdraw({ amount: 'max' })
    expect(decodeSent(acc.sent[0])).toMatchObject({ fn: 'redeem', args: [100n * E18, USER, USER] })
    await p.withdraw({ amount: 40n * E6, to: OTHER })
    expect(decodeSent(acc.sent[1])).toMatchObject({ fn: 'withdraw', args: [40n * E6, OTHER, USER] })
    state.vault.liquid = 30n * E6
    await expect(p.withdraw({ amount: 40n * E6 })).rejects.toThrow(/only 30000000 base units are withdrawable/)
    await expect(p.withdraw({ amount: 'max' })).rejects.toThrow(/only 30000000 of 100000000/)
    await expect(p.withdraw({ amount: 200n * E6 })).rejects.toThrow(/exceeds the position/)
  })

  it('borrow / repay are not implemented; read-only account cannot write; quotes never send', async () => {
    const { p, acc, state } = vault()
    await expect(p.borrow()).rejects.toBeInstanceOf(NotImplementedError)
    await expect(p.repay()).rejects.toBeInstanceOf(NotImplementedError)
    setBalance(state, VAULT, USER, E18)
    expect(await p.quoteSupply({ amount: E6 })).toMatchObject({ fee: 42_000n, approvals: 1 })
    expect(await p.quoteWithdraw({ amount: 'max' })).toMatchObject({ fee: 21_000n, assetsOut: E6 })
    expect(acc.sent).toHaveLength(0)
    const ro = new MorphoVaultProtocolEvm(acc.toReadOnlyAccount(), { chainId: 8453, vault: VAULT, provider: makeMorpho().chain.provider, api: null })
    await expect(ro.supply({ amount: 1n })).rejects.toBeInstanceOf(ReadOnlyAccountError)
  })

  it('a vault revert is decoded (MetaMorpho AllCapsReached)', async () => {
    const { p, state, acc } = vault()
    state.revertOn.set('deposit', 'x')
    setAllowance(state, USDC, USER, VAULT, E6) // no approval pending → the proof runs
    await expect(p.quoteSupply({ amount: E6 })).rejects.toThrow(/deposit would revert/)
    await expect(p.supply({ amount: E6 })).rejects.toBeInstanceOf(MorphoError)
    expect(acc.sent).toHaveLength(0)
    expect(decodeMorphoRevert('0xdeadbeef' as Hex).message).toMatch(/custom error 0xdeadbeef/)
    const allCaps = decodeMorphoRevert(toFunctionSelector('AllCapsReached()'))
    expect(allCaps.code).toBe('AllCapsReached')
  })
})

describe('market', () => {
  it('resolves from id or params (same market), refuses unknown markets and bad input', async () => {
    const byId = market()
    const byParams = market(account(), { market: { ...PARAMS, lltv: '860000000000000000' } })
    const [a, b] = await Promise.all([byId.p.getMarket(), byParams.p.getMarket()])
    expect(a.id).toBe(MARKET_ID)
    expect(b.id).toBe(MARKET_ID)
    expect(a.loan).toEqual({ address: USDC, symbol: 'USDC', decimals: 6 })
    expect(a.collateral).toEqual({ address: CBBTC, symbol: 'cbBTC', decimals: 8 })
    expect(a.lltv).toBe(0.86)
    expect(a.utilization).toBeCloseTo(0.9, 3)
    expect(a.borrowApy).toBeCloseTo(5.127, 2)
    expect(a.supplyApy).toBeCloseTo(5.127 * 0.9, 1)
    expect(a.liquidity).toBe(100_000n * E6)
    const unknown = market(account(), { market: `0x${'ab'.repeat(32)}` })
    await expect(unknown.p.getMarket()).rejects.toThrow(/not created/)
    expect(() => new MorphoMarketProtocolEvm(account(), { market: '0x12' as Hex })).toThrow(/32-byte market id/)
    expect(() => new MorphoMarketProtocolEvm(createMockAccount({ chain: 'eip155:5' }), { market: MARKET_ID })).toThrow(/No known Morpho deployment on chain 5/)
  })

  it('position: shares → assets, collateral value, health, liquidation price', async () => {
    const { p, state } = market()
    setPosition(state, USER, { supplyAssets: 1_000n * E6, borrowAssets: 50_000n * E6, collateral: E8 }) // 1 cbBTC = 100k USDC
    const pos = await p.getPosition()
    expect(pos.supplyAssets).toBe(1_000n * E6)
    expect(pos.borrowAssets).toBeGreaterThanOrEqual(50_000n * E6)
    expect(pos.collateralValue).toBe(100_000n * E6)
    expect(pos.maxBorrow).toBe(86_000n * E6)
    expect(pos.healthFactor).toBeCloseTo(1.72, 2)
    expect(pos.ltv).toBeCloseTo(0.5, 3)
    // liquidation when 1 cbBTC ≈ 50 000 / 0.86 ≈ 58 139.5 USDC
    expect(Number(pos.liquidationPrice!) / Number(state.price)).toBeCloseTo(0.5814, 3)
  })

  it('supply / withdraw the loan token: approve + supply; max withdraws by shares; liquidity bound', async () => {
    const { p, acc, state } = market()
    await p.supply({ amount: 100n * E6 })
    expect(acc.sent.map(decodeSent)).toMatchObject([
      { to: USDC, fn: 'approve', args: [MORPHO, 100n * E6] },
      { to: MORPHO, fn: 'supply' },
    ])
    const supplyArgs = decodeSent(acc.sent[1]).args
    expect(supplyArgs[1]).toBe(100n * E6)
    expect(supplyArgs[2]).toBe(0n)
    expect(supplyArgs[3]).toBe(USER)
    await expect(p.supply({ token: CBBTC, amount: 1n })).rejects.toThrow(/lends USDC/)
    setPosition(state, USER, { supplyAssets: 1_000n * E6 })
    await p.withdraw({ amount: 'max', to: OTHER })
    const w = decodeSent(acc.sent[2]).args
    expect(w[1]).toBe(0n)
    expect(w[2]).toBeGreaterThan(0n) // shares
    expect(w[4]).toBe(OTHER)
    state.market.totalBorrowAssets = state.market.totalSupplyAssets - 10n * E6 // 10 USDC left
    await expect(p.withdraw({ amount: 100n * E6 })).rejects.toThrow(/Only 10000000 USDC base units are available/)
  })

  it('collateral: supply with approve; withdraw refused when it would undercollateralize', async () => {
    const { p, acc, state } = market()
    await p.supplyCollateral({ amount: E8 })
    expect(acc.sent.map((t) => decodeSent(t).fn)).toEqual(['approve', 'supplyCollateral'])
    setPosition(state, USER, { borrowAssets: 50_000n * E6, collateral: E8 })
    await expect(p.withdrawCollateral({ amount: E8 / 2n })).rejects.toThrow(/undercollateralized/)
    const q = await p.quoteWithdrawCollateral({ amount: E8 / 10n })
    expect(q.healthAfter).toBeCloseTo(1.548, 2)
    await p.withdrawCollateral({ amount: E8 / 10n })
    expect(decodeSent(acc.sent[2]).fn).toBe('withdrawCollateral')
  })

  it('borrow: within LLTV and liquidity; onBehalfOf needs authorization', async () => {
    const { p, acc, state } = market()
    await expect(p.borrow({ amount: E6 })).rejects.toThrow(/No collateral/)
    setPosition(state, USER, { collateral: E8 })
    await expect(p.borrow({ amount: 90_000n * E6 })).rejects.toThrow(/exceed the position's limit/)
    await expect(p.borrow({ amount: 200_000n * E6 })).rejects.toThrow(/available to borrow/)
    const res = await p.borrow({ amount: 10_000n * E6, to: OTHER })
    expect(res.healthAfter).toBeCloseTo(8.6, 1)
    const b = decodeSent(acc.sent[0]).args
    expect(b[1]).toBe(10_000n * E6)
    expect(b[3]).toBe(USER)
    expect(b[4]).toBe(OTHER)
    await expect(p.borrow({ amount: E6, onBehalfOf: OTHER })).rejects.toThrow(/not authorized/)
    state.authorized.set(`${OTHER.toLowerCase()}:${USER.toLowerCase()}`, true)
    setPosition(state, OTHER, { collateral: E8 })
    await expect(p.borrow({ amount: E6, onBehalfOf: OTHER })).resolves.toBeTruthy()
  })

  it("repay: partial by assets, 'max' by shares with a 0.1 % allowance buffer", async () => {
    const { p, acc, state } = market()
    await expect(p.repay({ amount: 'max' })).rejects.toThrow(/no debt/)
    setPosition(state, USER, { borrowAssets: 1_000n * E6, collateral: E8 })
    const debt = (await p.getPosition()).borrowAssets
    await p.repay({ amount: 100n * E6 })
    expect(decodeSent(acc.sent[0]).args).toEqual([MORPHO, 100n * E6])
    expect(decodeSent(acc.sent[1]).args[1]).toBe(100n * E6)
    await p.repay({ amount: 'max' })
    expect(decodeSent(acc.sent[2]).args).toEqual([MORPHO, debt + debt / 1000n + 1n])
    const r = decodeSent(acc.sent[3]).args
    expect(r[1]).toBe(0n)
    expect(r[2]).toBeGreaterThan(0n) // shares
    await expect(p.repay({ amount: 2_000n * E6 })).rejects.toThrow(/exceeds the debt/)
  })

  it("Morpho's revert strings are translated; quotes never send; read-only refuses", async () => {
    const { p, acc, state } = market()
    setPosition(state, USER, { supplyAssets: 100n * E6, borrowAssets: 10n * E6, collateral: E8 })
    state.revertOn.set('withdraw', 'insufficient liquidity')
    const e = await p.quoteWithdraw({ amount: E6 }).catch((x) => x)
    expect(e).toBeInstanceOf(MorphoError)
    expect(e.message).toMatch(/not enough liquidity right now/)
    expect(e.code).toBe('insufficient liquidity')
    state.revertOn.clear()
    expect(await p.quoteBorrow({ amount: E6 })).toMatchObject({ fee: 21_000n, borrowApy: expect.any(Number) })
    expect(await p.quoteRepay({ amount: 'max' })).toMatchObject({ approvals: 1 })
    expect(acc.sent).toHaveLength(0)
    const ro = new MorphoMarketProtocolEvm(acc.toReadOnlyAccount(), { chainId: 8453, market: MARKET_ID, provider: makeMorpho().chain.provider, api: null })
    await expect(ro.borrow({ amount: 1n })).rejects.toBeInstanceOf(ReadOnlyAccountError)
    expect(decodeMorphoRevert(toErrorString('market not created'))).toMatchObject({ code: 'market not created' })
  })
})

describe('api client', () => {
  it('maps vaults and markets from the current schema, V2 best effort', async () => {
    const calls: string[] = []
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const q = JSON.parse(init.body).query as string
      calls.push(q)
      if (q.includes('vaultV2s')) return new Response(JSON.stringify({ errors: [{ message: 'nope' }] }))
      if (q.includes('vaults(')) return new Response(JSON.stringify({ data: { vaults: { items: [{ address: VAULT, name: 'Gauntlet USDC Prime', symbol: 'gtUSDCp', listed: true, factory: { address: '0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101' }, chain: { id: 8453 }, asset: { address: USDC, symbol: 'USDC', decimals: 6 }, state: { apy: 0.046, netApy: 0.0411, totalAssets: '414411117177972', totalAssetsUsd: 414293523.7, fee: 0.1 } }] } } }))
      if (q.includes('markets(')) return new Response(JSON.stringify({ data: { markets: { items: [{ marketId: MARKET_ID, listed: true, lltv: '860000000000000000', irmAddress: PARAMS.irm, chain: { id: 8453 }, oracle: { address: PARAMS.oracle }, loanAsset: { address: USDC, symbol: 'USDC', decimals: 6 }, collateralAsset: { address: CBBTC, symbol: 'cbBTC', decimals: 8 }, state: { supplyApy: 0.046, borrowApy: 0.0511, utilization: 0.9, supplyAssetsUsd: 1.7e9, liquidityAssets: '169282449553539' } }] } } }))
      return new Response(JSON.stringify({ data: {} }))
    }) as unknown as typeof fetch
    const api = new MorphoApi('https://example.invalid/graphql', fetchImpl)
    const vaults = await api.listVaults({ chainId: 8453, asset: USDC })
    expect(vaults).toHaveLength(1)
    expect(vaults[0]).toMatchObject({ version: 'v1', fee: 0.1, totalAssets: 414411117177972n })
    expect(vaults[0]!.netApy).toBeCloseTo(4.11, 6)
    const markets = await api.listMarkets({ chainId: 8453, loanToken: USDC })
    expect(markets[0]).toMatchObject({ id: MARKET_ID, lltv: 860000000000000000n, supplyApy: 4.6, liquidityAssets: 169282449553539n })
    expect(calls.some((q) => q.includes('listed'))).toBe(true)
  })
})

function toErrorString(s: string): Hex {
  const hex = Buffer.from(s, 'utf8').toString('hex')
  const len = s.length.toString(16).padStart(64, '0')
  return ('0x08c379a0' + '20'.padStart(64, '0') + len + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')) as Hex
}

describe('chain table', () => {
  it('every chain id resolves to a Morpho singleton and is advertised in MORPHO_CHAIN_IDS', () => {
    for (const [id, c] of Object.entries(MORPHO_CHAINS)) {
      expect(c.chainId).toBe(Number(id))
      expect(c.morpho).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(MORPHO_CHAIN_IDS).toContain(`eip155:${id}`)
    }
    expect(MORPHO_CHAIN_IDS.length).toBe(Object.keys(MORPHO_CHAINS).length)
  })

  it.each([
    [14, 'Flare', '0xF4346F5132e810f80a28487a79c7559d9797E8B0', '0x6FC83ECc0e8142635D77200e5052be8A0a9D2f42'],
    [5042, 'Arc', '0x34CD04070dD72b14E241112F6d83812Df5Af7fCD', '0x3b0eefaBfa22ec7CF2c73877ac16e78D76749f12'],
    [2818, 'Morph', '0xAd10d07901Dc3195c3cb5e78E061F4EA8D9B4905', '0x7D8BF8B276f967F7539c9e91E1a85a33fefE612B'],
    [747474, 'Katana', '0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc', '0xFcb8b57E56787bB29e130Fca67f3c5a1232975D1'],
  ])('chain %i (%s) pins Morpho %s and VaultV2Factory %s (docs.morpho.org, verified on-chain 2026-10-14)', (chainId, name, morpho, v2) => {
    const c = MORPHO_CHAINS[chainId]!
    expect(c).toMatchObject({ chainId, name, morpho })
    expect(c.vaultV2Factories).toContain(v2)
    if (chainId !== 747474) expect(c.vaultV1Factories).toEqual([]) // no MetaMorpho V1 factory on the 2026-10-14 chains
  })

  it('Mantle has no Morpho deployment (not on docs.morpho.org nor in the Morpho API chain list)', () => {
    expect(MORPHO_CHAINS[5000]).toBeUndefined()
    expect(MORPHO_CHAIN_IDS).not.toContain('eip155:5000')
  })
})
