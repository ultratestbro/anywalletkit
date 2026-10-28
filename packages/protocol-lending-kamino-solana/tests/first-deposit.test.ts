import { describe, expect, it } from 'vitest'
import { DEFAULT_FIRST_DEPOSIT_ALLOWANCE, DEFAULT_RENT_ALLOWANCE, vanillaObligation } from '../src/index.js'
import { MARKET, USDC, USER, account, api, obligation } from './fixture.js'
import { KaminoMarketProtocolSolana } from '../src/index.js'
import { OBLIGATION, defaultChain, obligationAccount } from './chain-fixture.js'

// Audit 2026-10-25 round 3, L22: the first-deposit allowance (0.045 SOL the guard lets the wallet
// spend on the obligation's rent) was granted whenever the obligations API failed — a guess that
// widened what a transaction may take — and any obligation in the market (a Multiply one, say)
// counted as "the obligation already exists" although the deposit goes through the vanilla one.
// Scan 2026-10-27 (modules): the question is now asked of the chain — does the vanilla obligation's
// account exist — so the API's list (which the live API now serves in another shape) decides nothing.

const make = () => {
  const f = api()
  const acc = account({ accounts: defaultChain() })
  return { f, acc, p: new KaminoMarketProtocolSolana(acc, { fetch: f.fetch }) }
}

describe('Kamino first deposit', () => {
  it('the vanilla obligation is derived as the program does (golden: the live API loanId)', () => {
    expect(vanillaObligation(USER, MARKET)).toBe(obligation.loanId)
  })

  it('a chain read that fails refuses the deposit instead of granting the allowance', async () => {
    const { p, acc } = make()
    acc.getAccountInfos = async () => { throw new Error('rpc down') }
    await expect(p.quoteSupply({ token: USDC, amount: 5_000_000n })).rejects.toThrow(/rpc down/)
    await expect(p.supply({ token: USDC, amount: 5_000_000n })).rejects.toThrow(/rpc down/)
    expect(acc.sent).toHaveLength(0)
  })

  it('only the vanilla obligation counts as set up; a Multiply obligation does not — and the API\'s list decides nothing', async () => {
    const { p, f, acc } = make()
    acc.accounts.set('9aVHeR2Rq9RGrmkZr7wCvvzZD1J4WbGtpnu6bHFwxv3p', obligationAccount({})) // another obligation of this user
    f.obligations = [obligation] // the API claims the vanilla one exists
    await p.quoteSupply({ token: USDC, amount: 5_000_000n })
    expect(acc.guards.at(-1)!.guard.expect.maxLamportsOut).toBe(DEFAULT_RENT_ALLOWANCE + DEFAULT_FIRST_DEPOSIT_ALLOWANCE)
    acc.accounts.set(OBLIGATION, obligationAccount({}))
    f.obligations = []
    await p.quoteSupply({ token: USDC, amount: 5_000_000n })
    expect(acc.guards.at(-1)!.guard.expect.maxLamportsOut).toBe(DEFAULT_RENT_ALLOWANCE)
  })
})
