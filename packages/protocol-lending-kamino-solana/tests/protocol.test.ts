import { describe, expect, it } from 'vitest'
import { NotImplementedError, ReadOnlyAccountError } from '@anywalletkit/core'
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM, FARMS_PROGRAM, KLEND_PROGRAM, KVAULT_PROGRAM, KaminoApi, KaminoError, KaminoMarketProtocolSolana, KaminoVaultProtocolSolana,
  WITHDRAW_ALL, DEFAULT_FIRST_DEPOSIT_ALLOWANCE, DEFAULT_RENT_ALLOWANCE, fromDecimalString, instructionName, lessBps, toDecimalString, toWad,
} from '../src/index.js'
import { divWadUp, WAD } from '../src/amounts.js'
import { FARM, vaultRow, MARKET, PYUSD, SHARES, SOL, SOL_RESERVE, TX, USDC, USDC_RESERVE, USER, VAULT, account as bare, api, obligation } from './fixture.js'
import { CHAIN_TPS, OBLIGATION, SHARES_ATA, USER_STATE, defaultChain, farmUserAccount, obligationAccount, tokenAccount } from './chain-fixture.js'
import { SF } from '../src/chain.js'

/** The fake account reading the recorded vault and market from its chain map (chain-fixture.ts). */
const account = (opts: Parameters<typeof bare>[0] = {}) => bare({ accounts: defaultChain(), ...opts })
/** The recorded obligation on chain too: 5.000123 USDC and 0.5 SOL deposited, 1.25 USDC borrowed (cTokens redeem 1:1). */
const withObligation = (acc: ReturnType<typeof account>) => acc.accounts.set(OBLIGATION, obligationAccount({
  deposits: [{ reserve: USDC_RESERVE, ctokens: 5_000_123n }, { reserve: SOL_RESERVE, ctokens: 500_000_000n }],
  borrows: [{ reserve: USDC_RESERVE, borrowedSf: 1_250_000n * SF }],
}))
const vaultRowOf = () => structuredClone(vaultRow) as typeof vaultRow & Record<string, unknown>
const vault = (acc = account(), extra: Record<string, unknown> = {}) => {
  const f = api()
  return { f, acc, p: new KaminoVaultProtocolSolana(acc, { vault: VAULT, fetch: f.fetch, asset: USDC, ...extra }) }
}
const market = (acc = account(), extra: Record<string, unknown> = {}) => {
  const f = api()
  return { f, acc, p: new KaminoMarketProtocolSolana(acc, { fetch: f.fetch, ...extra }) }
}
const lastPost = (f: ReturnType<typeof api>) => f.requests.filter((r) => r.method === 'POST').at(-1)! as { url: string; method: string; body: Record<string, unknown> }

describe('amounts', () => {
  it('base units ↔ the decimal strings the API speaks', () => {
    expect(toDecimalString(1_500_000n, 6)).toBe('1.5')
    expect(toDecimalString(5n, 6)).toBe('0.000005')
    expect(toDecimalString(1_000_000n, 6)).toBe('1')
    expect(fromDecimalString('1.0627800342202071868', 6)).toBe(1_062_780n)
    expect(fromDecimalString('4.66025618528313756439e-16', 9)).toBe(0n)
    expect(fromDecimalString('2292847.2166629909741', 9)).toBe(2_292_847_216_662_990n)
    expect(toWad('1.5')).toBe(15n * 10n ** 17n)
    expect(lessBps(1_000_000n, 50)).toBe(995_000n)
  })
  it('names the Kamino instructions the API transactions carry', () => {
    const d = (hex: string) => Uint8Array.from(Buffer.from(hex + '00', 'hex'))
    expect(instructionName(KLEND_PROGRAM, d('d8e0bf1bcc9766af'))).toBe('depositReserveLiquidityAndObligationCollateralV2')
    expect(instructionName(KVAULT_PROGRAM, d('f223c68952e1f2b6'))).toBe('deposit')
    expect(instructionName(FARMS_PROGRAM, d('ceb0ca12c8d1b36c'))).toBe('stake')
    expect(instructionName(KLEND_PROGRAM, d('0000000000000000'))).toBeUndefined()
  })
})

describe('KaminoVaultProtocolSolana', () => {
  it('describes the vault from the API: asset, shares, rate, fees, TVL', async () => {
    const { p } = vault()
    const v = await p.getVault()
    expect(v.asset).toEqual({ mint: USDC, decimals: 6, symbol: 'USDC' })
    expect(v.shares.mint).toBe(SHARES)
    expect(v.apy).toBeCloseTo(4.5155, 3)
    expect(v.fees).toEqual({ performanceBps: 500, managementBps: 0 })
    expect(v.totalAssets).toBe(80_843_116_919n + 19_873_153_911_276n)
    expect(v.allocations.map((a) => a.reserve)).toEqual([USDC_RESERVE])
    expect(v.farm).toBe(FARM)
    expect(await p.getApy()).toBeCloseTo(4.5155, 3)
  })

  it('quoteSupply builds the deposit through the API in token units and proves it through the guard without sending', async () => {
    const { p, f, acc } = vault(account(), { skipFarm: false })
    const q = await p.quoteSupply({ amount: 1_500_000n })
    expect(q.fee).toBe(7_500n)
    // Priced at the chain's rate (the vault's state and its reserve), which the API's agrees with.
    expect(q.expectedShares).toBe(divWadUp(fromDecimalString('1.5', 6), CHAIN_TPS))
    expect(q.expectedShares).toBe(fromDecimalString('1.5', 6) * 10n ** 18n / toWad('1.0627800342202071868') + 1n)
    expect(lastPost(f)).toMatchObject({ url: '/ktx/kvault/deposit', body: { wallet: USER, kvault: VAULT, amount: '1.5' } })
    expect(lastPost(f).body).toMatchObject({ skipFarm: false })
    expect(acc.sent).toHaveLength(0)
    const g = acc.guards[0]!
    expect(g.method).toBe('check')
    expect(g.base64).toBe(TX)
    expect(g.guard.programAllowlist).toEqual(expect.arrayContaining([KLEND_PROGRAM, KVAULT_PROGRAM, FARMS_PROGRAM, ADDRESS_LOOKUP_TABLE_PROGRAM]))
    expect(g.guard.expect).toEqual({ maxLamportsOut: DEFAULT_RENT_ALLOWANCE, maxTokenOut: { mint: USDC, amount: 1_500_000n } })
    // The deposit is pinned to this vault and the wallet's accounts; with the farm, staking into this farm's user state.
    expect(g.guard.instructions).toContainEqual(expect.objectContaining({ program: KVAULT_PROGRAM, data: 'f223c68952e1f2b6', accounts: expect.objectContaining({ 0: USER, 1: VAULT, 5: SHARES }) }))
    expect(g.guard.instructions).toContainEqual(expect.objectContaining({ program: FARMS_PROGRAM, data: 'ceb0ca12c8d1b36c', accounts: expect.objectContaining({ 1: USER_STATE, 2: FARM }) }))
  })

  it('supply signs through sendSerialized with the same guard; skipFarm proves the shares arrive', async () => {
    const { p, f, acc } = vault(account(), { skipFarm: true, memo: 'awk' })
    const r = await p.supply({ amount: 2_000_000n })
    expect(r).toEqual({ hash: 'sig1', fee: 7_500n })
    expect(lastPost(f).body).toMatchObject({ skipFarm: true, memo: 'awk' })
    const g = acc.guards.at(-1)!
    expect(g.method).toBe('send')
    expect(g.guard.expect.maxTokenOut).toEqual({ mint: USDC, amount: 2_000_000n })
    expect(g.guard.expect.tokenIn?.mint).toBe(SHARES)
    expect(g.guard.expect.tokenIn!.minAmount).toBeLessThan(2_000_000n)
    expect(g.guard.expect.tokenIn!.minAmount).toBeGreaterThan(1_800_000n)
  })

  it('refuses the wrong token, dust below the vault minimum, and a read-only account', async () => {
    const { p } = vault()
    await expect(p.quoteSupply({ token: SOL, amount: 1_000_000n })).rejects.toThrow(/takes USDC/)
    await expect(p.quoteSupply({ amount: 10n })).rejects.toThrow(/below the vault minimum/)
    await expect(p.quoteSupply({ amount: 0n })).rejects.toThrow(KaminoError)
    const ro = new KaminoVaultProtocolSolana(account().toReadOnlyAccount(), { vault: VAULT, fetch: api().fetch })
    await expect(ro.supply({ amount: 1_000_000n })).rejects.toBeInstanceOf(ReadOnlyAccountError)
    await expect(ro.withdraw({ amount: 'max' })).rejects.toBeInstanceOf(ReadOnlyAccountError)
  })

  it('reads the position as shares × tokensPerShare and withdraws by shares, max = every share', async () => {
    const { p, f, acc } = vault()
    f.position = { stakedShares: '10', unstakedShares: '0.5', totalShares: '10.5' }
    const pos = await p.getPosition()
    expect(pos.shares).toBe(10_500_000n)
    expect(pos.stakedShares).toBe(10_000_000n)
    expect(pos.assets).toBe(10_500_000n * toWad('1.0627800342202071868') / 10n ** 18n)

    // Writes take the position from the chain: the shares account and the farm stake.
    acc.accounts.set(SHARES_ATA, tokenAccount(SHARES, USER, 500_000n))
    acc.accounts.set(USER_STATE, farmUserAccount({ staked: 10_000_000n }))
    const assets = 10_500_000n * CHAIN_TPS / WAD
    const q = await p.quoteWithdraw({ amount: 'max' })
    expect(q.shares).toBe(10_500_000n)
    expect(q.expectedAssets).toBe(assets)
    expect(q.minAssets).toBe(lessBps(assets, 50))
    expect(lastPost(f)).toMatchObject({ url: '/ktx/kvault/withdraw', body: { wallet: USER, kvault: VAULT, amount: '10.5' } }) // every share, by count (WITHDRAW_ALL overflows the API now)
    expect(lastPost(f).body.amount).not.toBe(WITHDRAW_ALL)
    // the redeemed shares may leave the wallet (burned), exactly those (audit 2026-10-25, #1.3)
    expect(acc.guards.at(-1)!.guard.expect).toEqual({ maxLamportsOut: DEFAULT_RENT_ALLOWANCE, tokenIn: { mint: USDC, minAmount: lessBps(assets, 50) }, maxTokenOut: { mint: SHARES, amount: 10_500_000n } })

    await p.withdraw({ amount: 1_062_780n })  // ≈ 1 share's worth
    expect(lastPost(f).body.amount).toBe('1')
    expect(acc.sent).toHaveLength(1)
    await expect(p.quoteWithdraw({ amount: 100_000_000n })).rejects.toThrow(/exceeds the position/)
  })

  it('has no position → withdraw refuses; borrow / repay are not what a vault does', async () => {
    const { p } = vault()
    await expect(p.quoteWithdraw({ amount: 'max' })).rejects.toThrow(/No position/)
    await expect(p.borrow()).rejects.toBeInstanceOf(NotImplementedError)
    await expect(p.quoteRepay()).rejects.toBeInstanceOf(NotImplementedError)
  })

  it('refuses a non-mainnet Solana account up front and any other chain at the first call', async () => {
    expect(() => new KaminoVaultProtocolSolana(account({ chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }), { vault: VAULT })).toThrow(/mainnet/)
    const p = new KaminoVaultProtocolSolana(account({ chain: 'eip155:1' }), { vault: VAULT, fetch: api().fetch })
    await expect(p.getPosition()).rejects.toThrow(/Solana mainnet account/)
    expect(() => new KaminoVaultProtocolSolana(account(), { vault: 'nope' })).toThrow(/vault/)
    expect(() => new KaminoVaultProtocolSolana(account(), { vault: VAULT, slippageBps: 9_999 })).toThrow(/slippageBps/)
  })

  it('surfaces the API error code', async () => {
    const { p, f } = vault()
    f.routes.set('/ktx/kvault/deposit', { status: 400, body: { statusCode: 400, message: 'Amount overflow', error: 'Bad Request', code: 'DECIMAL_TO_LAMPORTS_OVERFLOW' } })
    await expect(p.quoteSupply({ amount: 1_000_000n })).rejects.toMatchObject({ code: 'DECIMAL_TO_LAMPORTS_OVERFLOW', message: expect.stringMatching(/Amount overflow/) })
  })
})

describe('KaminoMarketProtocolSolana', () => {
  it('lists reserves with utilization and resolves a mint to its deepest reserve unless pinned', async () => {
    const { p } = market()
    const rs = await p.getReserves()
    expect(rs.find((r) => r.reserve === USDC_RESERVE)!.utilization).toBeCloseTo(0.768, 2)
    expect((await p.resolveReserve(USDC)).reserve).toBe(USDC_RESERVE)
    expect((await p.resolveReserve(SOL)).reserve).toBe(SOL_RESERVE)
    await expect(p.resolveReserve(PYUSD)).rejects.toThrow(/no reserve/)
    const pinned = market(account(), { reserves: { [USDC]: 'AWnKJ9dsiHcoDCThxE5E93ikDTAXkApoNwrKM2tp9KFJ' } }).p
    expect((await pinned.resolveReserve(USDC)).reserve).toBe('AWnKJ9dsiHcoDCThxE5E93ikDTAXkApoNwrKM2tp9KFJ')
    const wrong = market(account(), { reserves: { [USDC]: SOL_RESERVE } }).p
    await expect(wrong.resolveReserve(USDC)).rejects.toThrow(/holds SOL/)
    const m = await p.getMarket()
    expect(m.isPrimary).toBe(true)
    expect(m.reserves).toHaveLength(3)
  })

  it('first deposit: obligation rent is allowed on top; later deposits only the usual rent', async () => {
    const { p, f, acc } = market()
    const q = await p.quoteSupply({ token: USDC, amount: 5_000_000n })
    expect(q.reserve).toBe(USDC_RESERVE)
    expect(lastPost(f)).toMatchObject({ url: '/ktx/klend/deposit', body: { wallet: USER, market: MARKET, reserve: USDC_RESERVE, amount: '5' } })
    expect(acc.guards.at(-1)!.guard.expect).toEqual({ maxLamportsOut: DEFAULT_RENT_ALLOWANCE + DEFAULT_FIRST_DEPOSIT_ALLOWANCE, maxTokenOut: { mint: USDC, amount: 5_000_000n } })
    expect(acc.guards.at(-1)!.guard.instructions).toContainEqual(expect.objectContaining({ program: KLEND_PROGRAM, data: 'd8e0bf1bcc9766af', accounts: expect.objectContaining({ 0: USER, 1: OBLIGATION, 2: MARKET, 4: USDC_RESERVE, 5: USDC }) }))
    withObligation(acc)
    await p.supply({ token: USDC, amount: 5_000_000n })
    expect(acc.guards.at(-1)!.guard.expect.maxLamportsOut).toBe(DEFAULT_RENT_ALLOWANCE)
    expect(acc.sent).toHaveLength(1)
  })

  it('a SOL deposit is bounded on the lamport side', async () => {
    const { p, f, acc } = market()
    withObligation(acc)
    await p.quoteSupply({ token: SOL, amount: 10n ** 9n })
    expect(lastPost(f).body).toMatchObject({ reserve: SOL_RESERVE, amount: '1' })
    expect(acc.guards.at(-1)!.guard.expect).toEqual({ maxLamportsOut: 10n ** 9n + DEFAULT_RENT_ALLOWANCE })
  })

  it('reads obligations into per-mint totals and resolves max against them', async () => {
    const { p, f, acc } = market()
    f.obligations = [obligation]
    withObligation(acc)
    const pos = await p.getPosition()
    expect(pos.obligations[0]!.obligation).toBe('zncEB2kLmREYgbVG6aPS6D6NamMjDskXM5pwh5Ejmeu')
    expect(pos.supplied).toEqual({ [USDC]: 5_000_123n, [SOL]: 500_000_000n })
    expect(pos.borrowed).toEqual({ [USDC]: 1_250_000n })
    expect(pos.obligations[0]!.currentLtv).toBeCloseTo(0.021)

    const w = await p.quoteWithdraw({ token: USDC, amount: 'max' })
    expect(lastPost(f)).toMatchObject({ url: '/ktx/klend/withdraw', body: { amount: '5.000123' } })
    expect(w.minReceived).toBe(lessBps(5_000_123n, 50))
    expect(acc.guards.at(-1)!.guard.expect.tokenIn).toEqual({ mint: USDC, minAmount: lessBps(5_000_123n, 50) })

    const b = await p.quoteBorrow({ token: USDC, amount: 1_000_000n })
    expect(lastPost(f).url).toBe('/ktx/klend/borrow')
    expect(b.minReceived).toBe(995_000n)
    // and no more than asked: a bigger borrow is debt the user did not choose
    expect(acc.guards.at(-1)!.guard.expect.tokenIn).toEqual({ mint: USDC, minAmount: 995_000n, maxAmount: 1_000_000n })

    await p.repay({ token: USDC, amount: 'max' })
    expect(lastPost(f)).toMatchObject({ url: '/ktx/klend/repay', body: { amount: '1.25' } })
    expect(acc.guards.at(-1)!.guard.expect.maxTokenOut).toEqual({ mint: USDC, amount: 1_256_250n })
    await expect(p.quoteRepay({ token: SOL, amount: 'max' })).rejects.toThrow(/Nothing borrowed/)
  })

  it('writes refuse a read-only account before any API call', async () => {
    const f = api()
    const p = new KaminoMarketProtocolSolana(account().toReadOnlyAccount(), { fetch: f.fetch })
    for (const call of [() => p.supply({ token: USDC, amount: 1n }), () => p.withdraw({ token: USDC, amount: 1n }), () => p.borrow({ token: USDC, amount: 1n }), () => p.repay({ token: USDC, amount: 1n })]) {
      await expect(call()).rejects.toBeInstanceOf(ReadOnlyAccountError)
    }
    expect(f.requests).toHaveLength(0)
  })

  it('an account that cannot read mints still writes: the reserve on chain carries the decimals', async () => {
    const { p, f, acc } = market(account({ mintInfo: false }))
    withObligation(acc)
    await p.quoteSupply({ token: USDC, amount: 1_000_000n })
    expect(lastPost(f).body.amount).toBe('1')
  })
})

describe('KaminoApi', () => {
  it('parses markets (primary first), reserves (percent APYs) and a 404 position as zero', async () => {
    const f = api()
    const a = new KaminoApi(undefined, f.fetch)
    const ms = await a.listMarkets()
    expect(ms[0]!.lendingMarket).toBe(MARKET)
    const rs = await a.getReserves(MARKET)
    const sol = rs.find((r) => r.symbol === 'SOL')!
    expect(sol).toMatchObject({ mint: SOL, maxLtv: 0.74 })
    expect(sol.supplyApy).toBeCloseTo(4.57)
    expect(await a.getVaultPosition(USER, VAULT)).toEqual({ vaultAddress: VAULT, stakedShares: '0', unstakedShares: '0', totalShares: '0' })
    f.routes.set('/kvaults/users', { status: 500, body: { error: 'boom' } })
    await expect(a.getVaultPosition(USER, VAULT)).rejects.toThrow(/500/)
  })
})

// Audit 2026-10-25 round 3, H7: the vault's mints came from api.kamino.finance unchecked. An answer
// naming the wallet's USDT as the "shares mint" made withdraw('max') allow every USDT out, and a
// supply without `token` deposited whatever asset the API named.
describe('Kamino vault: the API cannot choose the mints', () => {
  const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
  const lying = (state: Record<string, unknown>, top: Record<string, unknown> = {}) => {
    const { f, acc, p } = vault()
    f.vault = { ...vaultRowOf(), ...top, state: { ...vaultRowOf().state, ...state } }
    f.position = { stakedShares: '0', unstakedShares: '10', totalShares: '10' }
    return { f, acc, p }
  }
  it('a shares mint the vault program would not derive is refused before anything is built', async () => {
    const { f, acc, p } = lying({ sharesMint: USDT })
    await expect(p.getVault()).rejects.toThrow(/shares mint .* is not the vault's/)
    await expect(p.withdraw({ amount: 'max' })).rejects.toThrow(KaminoError)
    expect(f.requests.some((r) => r.url.startsWith('/ktx/'))).toBe(false)
    expect(acc.guards).toHaveLength(0)
  })
  it('another vault, another program or another asset than configured is refused', async () => {
    await expect(lying({}, { address: USER }).p.getVault()).rejects.toThrow(/describes/)
    await expect(lying({}, { programId: KLEND_PROGRAM }).p.getVault()).rejects.toThrow(/not the kVault program/)
    await expect(lying({ tokenMint: PYUSD }).p.supply({ amount: 1_000_000n })).rejects.toThrow(/not the configured/)
  })
  it('supply names its asset: without token or a configured asset nothing is deposited', async () => {
    const f = api()
    const p = new KaminoVaultProtocolSolana(account(), { vault: VAULT, fetch: f.fetch })
    await expect(p.supply({ amount: 1_000_000n })).rejects.toThrow(/Name the asset/)
    await expect(p.quoteSupply({ token: USDC, amount: 1_500_000n })).resolves.toBeDefined()
  })
  it('the API\'s mint decimals must be the chain\'s', async () => {
    await expect(lying({ sharesMintDecimals: 9 }).p.getVault()).rejects.toThrow(/decimals/)
  })
})

// Review of round 3 H7: staked in the farm, the shares never reach the wallet, so the guard could
// only bound the spend — an API transaction that just transferred the deposit away passed.
describe('Kamino vault: shares stay in the wallet by default, where the guard proves them', () => {
  it('supply asks for skipFarm and requires the shares to arrive; skipFarm: false opts into the farm', async () => {
    const { p, f, acc } = vault()
    const q = await p.quoteSupply({ amount: 1_500_000n })
    expect(lastPost(f).body).toMatchObject({ skipFarm: true })
    expect(acc.guards.at(-1)!.guard.expect.tokenIn).toEqual({ mint: SHARES, minAmount: lessBps(q.expectedShares, 50) })
    const farm = vault(account(), { skipFarm: false })
    await farm.p.quoteSupply({ amount: 1_500_000n })
    expect(farm.acc.guards.at(-1)!.guard.expect.tokenIn).toBeUndefined()
  })
})
