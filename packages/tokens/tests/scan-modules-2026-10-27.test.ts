// Scan 2026-10-27 (modules), F28/F36: the table stored a symbol cut to 128 characters but assessed the whole one, so
// "USDC" + 124 spaces + "X" was stored (and shown) as "USDC" with no impersonation warning; and the folding knew
// Cyrillic / Greek look-alikes but not ASCII ones, so "DAl" and "USDl" passed as their own tokens.
import { describe, expect, it } from 'vitest'
import type { TokenInfo } from '@anywalletkit/core'
import { TOKEN_SYMBOL_MAX, TokensTable, assessToken, foldSymbol, inspectToken, memoryJsonStorage, tokenText, type TokensState } from '../src/index.js'

const ADDR = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'
const info = (over: Partial<TokenInfo> = {}): TokenInfo => ({ address: ADDR, standard: 'erc20', decimals: 18, symbol: 'PEPE', name: 'Pepe', totalSupply: 10n ** 30n, flags: [], ...over })
const account = (symbol: string, name = 'Token') => ({ chain: 'eip155:1', getTokenInfo: async (a: string) => info({ address: a, symbol, name }) })
const risk = (i: TokenInfo, code: string, chain?: string) => assessToken(i, chain).risks.find((r) => r.code === code)
/** An inspection of a token the catalog does not list. */
const inspect = async (acc: ReturnType<typeof account>) => {
  const r = await inspectToken(acc, ADDR)
  if (r.listed) throw new Error('listed')
  return r
}

describe('what is stored is what is assessed (scan 2026-10-27 modules, F28)', () => {
  it('"USDC" + 124 spaces + "X": stored as "USDC" and flagged as impersonation', async () => {
    const r = await inspect(account(`USDC${' '.repeat(124)}X`))
    expect(r.token.symbol).toBe('USDC')
    expect(r.assessment.level).toBe('danger')
    expect(r.assessment.risks[0]!.code).toBe('impersonation')
    // assessToken alone (a host that shows the raw symbol cut by its own UI) flags it too.
    expect(risk(info({ symbol: `USDC${' '.repeat(124)}X` }), 'impersonation')).toBeDefined()
  })

  it('symbols are trimmed and cut to TOKEN_SYMBOL_MAX code points before anything reads them, in the table as well', async () => {
    expect(tokenText(`  ${'A'.repeat(40)}  `, TOKEN_SYMBOL_MAX)).toBe('A'.repeat(32))
    expect(tokenText('😀'.repeat(40), 3)).toBe('😀😀😀') // no half surrogate pair at the cut
    expect(foldSymbol(`USDT${'x'.repeat(100_000)}`)).toHaveLength(TOKEN_SYMBOL_MAX)
    const table = new TokensTable(memoryJsonStorage<TokensState>())
    await table.load()
    const r = await inspect(account(`  PEPE${' '.repeat(10)}`, ` ${'n'.repeat(300)} `))
    const stored = await table.add({ ...r.token, symbol: `  WEIRD${' '.repeat(50)}TAIL ` })
    expect(stored.symbol).toBe('WEIRD')
    expect(r.token.symbol).toBe('PEPE')
    expect(r.token.name).toHaveLength(128)
  })
})

describe('the fold is a confusables skeleton; another script is danger (scan 2026-10-27 modules, F36)', () => {
  it('"DAl", "USDl", "USDT0"-style ASCII look-alikes read as the tokens they imitate', () => {
    for (const [symbol, like] of [['DAl', 'DAI'], ['USDl', 'USD1'], ['USD|', 'USD1'], ['W8TC', null], ['WBTC', 'WBTC'], ['wbtc', 'WBTC'], ['VVETH', 'WETH'], ['USDÇ', 'USDC'], ['ÛSDT', 'USDT'], ['ÐAI', 'DAI'], ['USD©', null]] as const) {
      const r = risk(info({ symbol }), 'impersonation')
      if (like) expect(r?.message, symbol).toMatch(new RegExp(`like ${like}\\b`))
      else expect(r, symbol).toBeUndefined()
    }
    expect(foldSymbol('DAl')).toBe(foldSymbol('DAI'))
    expect(foldSymbol('0KB')).toBe(foldSymbol('OKB'))
  })

  it('Cyrillic, Greek, Cherokee, math letters, emoji or invisible characters in a symbol are danger; Latin accents only caution', () => {
    for (const symbol of ['РЕРЕ' /* Cyrillic */, 'ΑΒΓ', 'ᏚᎪᎷ' /* Cherokee */, '𝐏𝐄𝐏𝐄', 'PEPE🐸', 'PE​PE']) {
      const r = risk(info({ symbol }), 'odd-characters')
      expect(r?.level, symbol).toBe('danger')
    }
    expect(risk(info({ symbol: 'CAFÉ' }), 'odd-characters')?.level).toBe('caution')
    expect(risk(info({ symbol: 'PE PE' }), 'odd-characters')?.level).toBe('caution') // a space inside the symbol
    expect(risk(info({ name: 'Pépé' }), 'odd-characters')?.level).toBe('caution')
    expect(risk(info(), 'odd-characters')).toBeUndefined()
  })
})
