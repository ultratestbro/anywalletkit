import { describe, expect, it } from 'vitest'
import { DEFAULT_FIRST_DEPOSIT_ALLOWANCE, DEFAULT_RENT_ALLOWANCE, vanillaObligation } from '../src/index.js'
import { MARKET, USDC, USER, account, api, obligation } from './fixture.js'
import { KaminoMarketProtocolSolana } from '../src/index.js'

// Audit 2026-10-25 round 3, L22: the first-deposit allowance (0.045 SOL the guard lets the wallet
// spend on the obligation's rent) was granted whenever the obligations API failed — a guess that
// widened what a transaction may take — and any obligation in the market (a Multiply one, say)
// counted as "the obligation already exists" although the deposit goes through the vanilla one.

const make = () => {
  const f = api()
  const acc = account()
  return { f, acc, p: new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }) }
}

describe('Kamino first deposit', () => {
  it('the vanilla obligation is derived as the program does (golden: the live API loanId)', () => {
    expect(vanillaObligation(USER, MARKET)).toBe(obligation.loanId)
  })

  it('an obligations API error refuses the deposit instead of granting the allowance', async () => {
    const { p, f, acc } = make()
    f.routes.set(`/kamino-market/${MARKET}/users/${USER}/obligations`, { status: 503, body: { message: 'down' } })
    await expect(p.quoteSupply({ token: USDC, amount: 5_000_000n })).rejects.toThrow(/could not tell whether/)
    await expect(p.supply({ token: USDC, amount: 5_000_000n })).rejects.toThrow(/could not tell whether/)
    expect(acc.sent).toHaveLength(0)
  })

  it('only the vanilla obligation counts as set up; a Multiply obligation does not', async () => {
    const { p, f, acc } = make()
    f.obligations = [{ ...obligation, loanId: '9aVHeR2Rq9RGrmkZr7wCvvzZD1J4WbGtpnu6bHFwxv3p' }] // another obligation of this user
    await p.quoteSupply({ token: USDC, amount: 5_000_000n })
    expect(acc.guards.at(-1)!.guard.expect.maxLamportsOut).toBe(DEFAULT_RENT_ALLOWANCE + DEFAULT_FIRST_DEPOSIT_ALLOWANCE)
    f.obligations = [obligation]
    await p.quoteSupply({ token: USDC, amount: 5_000_000n })
    expect(acc.guards.at(-1)!.guard.expect.maxLamportsOut).toBe(DEFAULT_RENT_ALLOWANCE)
  })
})
