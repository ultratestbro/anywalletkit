// Scan 2026-10-28, F10: a figure from the Kamino API in scientific notation had no bound on its
// exponent, so a few bytes ("1e300000000") became a string and BigInt of hundreds of millions of
// digits on the JS thread. The exponent, the input and the result are bounded; decimals fit a u8.
import { describe, expect, it } from 'vitest'
import { KaminoError, KaminoVaultProtocolSolana, fromDecimalString, toDecimalString } from '../src/index.js'
import { MAX_DIGITS, MAX_EXPONENT } from '../src/amounts.js'
import { USDC, VAULT, account, api, vaultMetrics } from './fixture.js'

const fast = (f: () => unknown) => {
  const t0 = performance.now()
  expect(f).toThrow(KaminoError)
  expect(performance.now() - t0).toBeLessThan(50)
}

describe('F10: fromDecimalString refuses an unbounded exponent or digit count, fast', () => {
  it('the repro ladder is refused at once', () => {
    for (const v of ['1e1000', '1e100000', '1e10000000', '1e100000000', '1e300000000', '1e600000000', '1e-600000000', `1e${'9'.repeat(400)}`]) fast(() => fromDecimalString(v, 18))
  })

  it('the bounds: |exponent| up to 400, the input and the base-unit result up to 1 000 digits', () => {
    expect(fromDecimalString(`1e${MAX_EXPONENT}`, 0)).toBe(10n ** 400n)
    expect(fromDecimalString(`1e-${MAX_EXPONENT}`, 18)).toBe(0n)
    fast(() => fromDecimalString(`1e${MAX_EXPONENT + 1}`, 0))
    fast(() => fromDecimalString(`1e-${MAX_EXPONENT + 1}`, 0))
    fast(() => fromDecimalString('1'.repeat(MAX_DIGITS + 1), 0))
    fast(() => fromDecimalString(`${'9'.repeat(900)}e300`, 0)) // short input, 1 200 digits out
    fast(() => fromDecimalString(`${'9'.repeat(800)}`, 255)) // 1 055 digits once scaled
    // Real figures keep parsing.
    expect(fromDecimalString('4.6e-16', 18)).toBe(460n)
    expect(fromDecimalString('1.0627800342202071868', 18)).toBe(1_062_780_034_220_207_186n)
    expect(fromDecimalString(1e21, 0)).toBe(10n ** 21n)
  })

  it('decimals must fit a u8, both ways', () => {
    for (const d of [256, -1, 1.5, Number.NaN, 1e9]) {
      fast(() => fromDecimalString('1', d))
      fast(() => toDecimalString(1n, d))
    }
    expect(toDecimalString(1n, 255)).toBe(`0.${'0'.repeat(254)}1`)
    expect(fromDecimalString('1', 255)).toBe(10n ** 255n)
  })

  it('through the API: a huge tokensPerShare from /metrics is refused by getVault and getPosition', async () => {
    for (const tps of ['1e1000', '1e100000', '1e5000000']) {
      const f = api()
      f.routes.set(`/kvaults/vaults/${VAULT}/metrics`, { status: 200, body: { ...vaultMetrics, tokensPerShare: tps } })
      const p = new KaminoVaultProtocolSolana(account(), { vault: VAULT, fetch: f.fetch, asset: USDC })
      await expect(p.getVault()).rejects.toThrow(/exponent/)
      await expect(p.getPosition()).rejects.toThrow(/exponent/)
    }
  })
})
