// Watch 2026-11-04: GET /kamino-market/<market>/users/<owner>/obligations answers `deposits: {}` and
// `borrows: {}` and keeps the obligation's legs only in its raw `state` (cTokens per reserve, debt × 2^60)
// and `refreshedStats` (USD). `getPosition()` read the empty legs and reported no position for a wallet
// with ~3.05M USDC supplied; the API-vs-chain check on a Lend 'max' never ran. The position now comes
// from the chain, and the check values the API's `state` at the reserves' on-chain rates.
// Fixture: the live API response for that wallet and its obligation + the USDC reserve as mainnet held
// them (one slot apart), recorded 2026-11-04, addresses as-is.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { KaminoApi, KaminoError, KaminoMarketProtocolSolana, toDecimalString } from '../src/index.js'
import { SF, decodeObligation, decodeReserve, depositedLiquidity, withinTolerance, type ChainAccount } from '../src/chain.js'
import { vanillaObligation } from '../src/pda.js'
import { MARKET, SOL, SOL_RESERVE, USDC, USDC_RESERVE, USER, account, api, obligation as decorated } from './fixture.js'
import { OBLIGATION, defaultChain, obligationAccount, reserveAccount } from './chain-fixture.js'

interface Recorded {
  wallet: string; obligation: string; reserve: string; market: string
  obligations: Array<Record<string, unknown> & { state: { deposits: Array<Record<string, unknown>> }; refreshedStats: { userTotalDeposit: string } }>
  accounts: Record<string, { owner: string; lamports: string; data: string }>
}
const LIVE = JSON.parse(readFileSync(new URL('./fixtures/live-obligation-2026-11-04.json', import.meta.url), 'utf8')) as Recorded
const liveChain = () => new Map<string, ChainAccount>(Object.entries(LIVE.accounts).map(([a, x]) => [a, { owner: x.owner, lamports: BigInt(x.lamports), data: Uint8Array.from(Buffer.from(x.data, 'base64')) }]))
/** What the recorded obligation's USDC redeems for at the recorded reserve's rate. */
const LIVE_SUPPLIED = (() => {
  const c = liveChain()
  return depositedLiquidity(decodeObligation(LIVE.obligation, c.get(LIVE.obligation)!), decodeReserve(LIVE.reserve, c.get(LIVE.reserve)!), LIVE.reserve)
})()
const ATTACKER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'

const ktxCalls = (f: ReturnType<typeof api>) => f.requests.filter((r) => r.url.startsWith('/ktx/'))

/** The recorded wallet as a read-only-ish fake account, the API answering its recorded obligations (or `rows`). */
function live(rows: unknown = LIVE.obligations) {
  const acc = account({ address: LIVE.wallet, accounts: liveChain() })
  const f = api()
  f.routes.set(`/kamino-market/${MARKET}/users/${LIVE.wallet}/obligations`, { status: 200, body: rows })
  return { acc, f, p: new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }) }
}
/** The recorded rows with the USDC deposit's cTokens in `state` scaled by `num / den`. */
function scaledState(num: bigint, den: bigint) {
  const rows = structuredClone(LIVE.obligations)
  const leg = rows[0]!.state.deposits[0]!
  leg.depositedAmount = String((BigInt(String(leg.depositedAmount)) * num) / den)
  return rows
}

describe('the recorded live answer', () => {
  it('is the shape the bug came from: empty object legs, the real ones in state, the vanilla obligation of the wallet', () => {
    const row = LIVE.obligations[0]!
    expect(row.deposits).toEqual({})
    expect(row.borrows).toEqual({})
    expect(row.obligationAddress).toBe(LIVE.obligation)
    expect(vanillaObligation(LIVE.wallet, MARKET)).toBe(LIVE.obligation)
    expect(LIVE.reserve).toBe(USDC_RESERVE)
    // ~3.05M USDC on chain, and the API's own USD total agrees.
    expect(LIVE_SUPPLIED).toBe(3_049_982_905_593n)
    expect(withinTolerance(BigInt(Math.round(Number(row.refreshedStats.userTotalDeposit) * 1e6)), LIVE_SUPPLIED)).toBe(true)
  })

  it('KaminoApi decodes the raw state into legs (cTokens per reserve, empty slots dropped)', async () => {
    const f = api()
    f.routes.set(`/kamino-market/${MARKET}/users/${LIVE.wallet}/obligations`, { status: 200, body: LIVE.obligations })
    const [o] = await new KaminoApi(undefined, f.fetch).getUserObligations(MARKET, LIVE.wallet)
    expect(o!.obligation).toBe(LIVE.obligation)
    expect(o!.deposits).toEqual([])
    expect(o!.borrows).toEqual([])
    expect(o!.state).toEqual({ owner: LIVE.wallet, lendingMarket: MARKET, deposits: [{ reserve: USDC_RESERVE, ctokens: 2_522_117_428_027n }], borrows: [] })
  })
})

describe('getPosition reads the obligations from the chain', () => {
  it('object-shaped empty legs + populated state: the position is the chain\'s ~3.05M USDC, leg by leg', async () => {
    const { p } = live()
    const pos = await p.getPosition()
    expect(pos.supplied).toEqual({ [USDC]: LIVE_SUPPLIED })
    expect(pos.borrowed).toEqual({})
    expect(pos.obligations).toHaveLength(1)
    expect(pos.obligations[0]!.obligation).toBe(LIVE.obligation)
    expect(pos.obligations[0]!.deposits).toEqual([{ mint: USDC, symbol: 'USDC', amount: toDecimalString(LIVE_SUPPLIED, 6), valueUsd: '', reserve: USDC_RESERVE }])
    expect(pos.obligations[0]!.borrows).toEqual([])
  })

  it('the old array shape still works: legs and totals from the chain, the API\'s USD figure kept where it fits', async () => {
    const acc = account({ accounts: defaultChain() })
    acc.accounts.set(OBLIGATION, obligationAccount({
      deposits: [{ reserve: USDC_RESERVE, ctokens: 5_000_123n }, { reserve: SOL_RESERVE, ctokens: 500_000_000n }],
      borrows: [{ reserve: USDC_RESERVE, borrowedSf: 1_250_000n * SF }],
    }))
    const f = api()
    f.obligations = [decorated]
    const pos = await new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }).getPosition()
    expect(pos.supplied).toEqual({ [USDC]: 5_000_123n, [SOL]: 500_000_000n })
    expect(pos.borrowed).toEqual({ [USDC]: 1_250_000n })
    expect(pos.obligations[0]!.currentLtv).toBeCloseTo(0.021)
    expect(pos.obligations[0]!.deposits).toEqual([
      { mint: USDC, symbol: 'USDC', amount: '5.000123', valueUsd: '4.99', reserve: USDC_RESERVE },
      { mint: SOL, symbol: 'SOL', amount: '0.5', valueUsd: '53.7', reserve: SOL_RESERVE },
    ])
    expect(pos.obligations[0]!.borrows).toEqual([{ mint: USDC, symbol: 'USDC', amount: '1.25', valueUsd: '1.25', reserve: USDC_RESERVE }])
  })

  it('the API cannot inflate a position: decorated legs that disagree with the chain are not what is reported', async () => {
    const acc = account({ accounts: defaultChain() })
    acc.accounts.set(OBLIGATION, obligationAccount({ deposits: [{ reserve: USDC_RESERVE, ctokens: 1_000_000n }] }))
    const f = api()
    f.obligations = [{ ...decorated, loanInfo: { ...decorated.loanInfo, collateral: { deposits: [{ tokenMint: USDC, tokenName: 'USDC', tokenAmount: '1000000', tokenValue: '1000000' }] } } }]
    const pos = await new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }).getPosition()
    expect(pos.supplied).toEqual({ [USDC]: 1_000_000n })
  })

  it('the vanilla obligation counts even when the API leaves it out; a listed obligation that is closed does not', async () => {
    const acc = account({ accounts: defaultChain() })
    acc.accounts.set(OBLIGATION, obligationAccount({ deposits: [{ reserve: USDC_RESERVE, ctokens: 7_000_000n }] }))
    const f = api()
    f.obligations = [{ ...decorated, loanId: '9aVHeR2Rq9RGrmkZr7wCvvzZD1J4WbGtpnu6bHFwxv3p' }] // a Multiply one the chain no longer has
    const pos = await new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }).getPosition()
    expect(pos.supplied).toEqual({ [USDC]: 7_000_000n })
    expect(pos.obligations.map((o) => o.obligation)).toEqual([OBLIGATION])
    expect(pos.obligations[0]!).toMatchObject({ user: USER, market: MARKET, state: null, raw: null })

    acc.accounts.delete(OBLIGATION)
    expect(await new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }).getPosition()).toEqual({ obligations: [], supplied: {}, borrowed: {} })
  })

  it('an obligation the API names must be the wallet\'s on this market, and its reserves this market\'s', async () => {
    const acc = account({ accounts: defaultChain() })
    const other = '9aVHeR2Rq9RGrmkZr7wCvvzZD1J4WbGtpnu6bHFwxv3p'
    acc.accounts.set(other, obligationAccount({ owner: ATTACKER, deposits: [{ reserve: USDC_RESERVE, ctokens: 10n ** 12n }] }))
    const f = api()
    f.obligations = [{ ...decorated, loanId: other }]
    await expect(new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }).getPosition()).rejects.toThrow(/is not KUMt.*'s on market/)

    acc.accounts.delete(other)
    acc.accounts.set(OBLIGATION, obligationAccount({ deposits: [{ reserve: USDC_RESERVE, ctokens: 1n }] }))
    acc.accounts.set(USDC_RESERVE, reserveAccount({ market: 'DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek', mint: USDC, available: 1n, collateralSupply: 1n }))
    await expect(new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }).getPosition()).rejects.toThrow(/belongs to market DxXdAy/)
  })

  it('without chain reads there is no position to report: the API is not taken on its word', async () => {
    const acc = account()
    delete (acc as Partial<typeof acc>).getAccountInfos
    const f = api()
    f.obligations = [decorated]
    await expect(new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }).getPosition()).rejects.toThrow(/getAccountInfos/)
  })
})

describe('a Lend \'max\' checks the API\'s state against the chain', () => {
  it('the recorded state agrees with the chain: max withdraws the chain\'s amount', async () => {
    const { acc, f, p } = live()
    const q = await p.quoteWithdraw({ token: USDC, amount: 'max' })
    expect(ktxCalls(f).at(-1)!.body).toMatchObject({ wallet: LIVE.wallet, reserve: USDC_RESERVE, amount: toDecimalString(LIVE_SUPPLIED, 6) })
    expect(q.minReceived).toBe((LIVE_SUPPLIED * 9_950n) / 10_000n)
    expect(acc.guards).toHaveLength(1)
  })

  it('a state within 1% of the chain passes; more than 1% off is refused before anything is built', async () => {
    const within = live(scaledState(1_005n, 1_000n))
    await within.p.quoteWithdraw({ token: USDC, amount: 'max' })
    expect(ktxCalls(within.f)).toHaveLength(1)

    for (const [num, den] of [[102n, 100n], [98n, 100n]] as const) {
      const off = live(scaledState(num, den))
      await expect(off.p.withdraw({ token: USDC, amount: 'max' })).rejects.toThrow(/Kamino reports \d+ base units supplied in EPjF.*has 3049982905593 on chain/)
      expect(ktxCalls(off.f)).toHaveLength(0)
      expect(off.acc.guards).toHaveLength(0)
    }
  })

  it('debt in the state is valued with the reserve\'s borrow rate; an inflated one is refused', async () => {
    const rate = (SF * 101n) / 100n
    const make = (borrowedSf: bigint) => {
      const acc = account({ accounts: defaultChain() })
      acc.accounts.set(OBLIGATION, obligationAccount({ borrows: [{ reserve: USDC_RESERVE, borrowedSf: 10_000_000n * SF, cumulativeBorrowRate: SF }] }))
      acc.accounts.set(USDC_RESERVE, reserveAccount({ mint: USDC, available: 10n ** 15n, collateralSupply: 10n ** 15n, cumulativeBorrowRate: rate }))
      const limbs = [SF & (2n ** 64n - 1n), SF >> 64n, 0n, 0n].map(String)
      const f = api()
      f.obligations = [{
        obligationAddress: OBLIGATION, deposits: {}, borrows: {}, refreshedStats: {}, humanTag: 'Vanilla',
        state: { owner: USER, lendingMarket: MARKET, deposits: [], borrows: [{ borrowReserve: USDC_RESERVE, borrowedAmountSf: String(borrowedSf), cumulativeBorrowRateBsf: { value: limbs, padding: ['0', '0'] } }] },
      }]
      return { acc, f, p: new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }) }
    }
    const ok = make(10_000_000n * SF)
    await ok.p.quoteRepay({ token: USDC, amount: 'max' })
    expect(ktxCalls(ok.f).at(-1)!.body).toMatchObject({ amount: '10.1' })
    expect((await ok.p.getPosition()).borrowed).toEqual({ [USDC]: 10_100_000n })

    const inflated = make(20_000_000n * SF)
    await expect(inflated.p.repay({ token: USDC, amount: 'max' })).rejects.toThrow(/reports 20200000 base units borrowed .* has 10100000 on chain/)
    expect(ktxCalls(inflated.f)).toHaveLength(0)
  })

  it('a state naming a reserve that is not a Kamino Reserve on this market is refused', async () => {
    const rows = structuredClone(LIVE.obligations)
    rows[0]!.state.deposits[1] = { depositReserve: SOL_RESERVE, depositedAmount: '5' }
    const { acc, f, p } = live(rows)
    acc.accounts.set(SOL_RESERVE, { ...reserveAccount({ mint: SOL, decimals: 9, available: 1n, collateralSupply: 1n }), owner: ATTACKER })
    await expect(p.withdraw({ token: USDC, amount: 'max' })).rejects.toThrow(/is not a Kamino Reserve/)
    expect(ktxCalls(f)).toHaveLength(0)
  })

  it('a malformed figure in the state is refused, not read as zero', async () => {
    for (const bad of ['-5', '1.5', '1e9', '', '18446744073709551616']) {
      const rows = structuredClone(LIVE.obligations)
      rows[0]!.state.deposits[0]!.depositedAmount = bad
      const { f, p } = live(rows)
      await expect(p.withdraw({ token: USDC, amount: 'max' })).rejects.toThrow(KaminoError)
      await expect(p.getPosition()).rejects.toThrow(/depositedAmount .* it is a u64/)
      expect(ktxCalls(f)).toHaveLength(0)
    }
  })
})
