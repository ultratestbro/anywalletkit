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

  it('letters that pass for Latin and characters that hide are danger; emoji, CJK and accents a caution (owner decision 2026-10-28)', () => {
    for (const symbol of ['РЕРЕ' /* Cyrillic */, 'ΑΒΓ', 'ᏚᎪᎷ' /* Cherokee */, 'ᗅᑭᗴ' /* Canadian syllabics */, 'ᴜsᴅᴄ' /* small capitals */, '𝐏𝐄𝐏𝐄', 'ℂℍ𝕀ℕ', 'ⓊⓈⒹ',
      'PE\u200BPE', 'PE\u202EPE' /* bidi override */, '\uFEFFPEPE']) {
      expect(risk(info({ symbol }), 'odd-characters')?.level, symbol).toBe('danger')
    }
    for (const symbol of ['PEPE🐸', '猫币', 'LOVE❤\uFE0F' /* variation selector */, 'FAM👨\u200D👩\u200D👧' /* emoji joiner */, 'CAFÉ', 'PE PE', 'NUÑEZ']) {
      expect(risk(info({ symbol }), 'odd-characters')?.level, symbol).toBe('caution')
    }
    expect(risk(info({ name: 'Pépé' }), 'odd-characters')?.level).toBe('caution')
    expect(risk(info({ name: 'Pe\u200Bpe' }), 'odd-characters')?.level).toBe('caution') // the name is shown next to the symbol, not as it
    expect(risk(info(), 'odd-characters')).toBeUndefined()
  })

  it('the review of 2026-10-28: controls, line breaks, blanks and tag characters hide; more look-alike blocks; ™ is not one', () => {
    const danger = (symbol: string) => expect(risk(info({ symbol }), 'odd-characters')?.level, JSON.stringify(symbol)).toBe('danger')
    const caution = (symbol: string) => expect(risk(info({ symbol }), 'odd-characters')?.level, JSON.stringify(symbol)).toBe('caution')
    // hiding: C0 / C1 controls, a line break inside, braille blank, interlinear annotation, tag characters (ASCII smuggling), astral format controls
    for (const symbol of ['US\u0000DC', 'PE\u0085PE', 'PE\nPE', 'PE\u2028PE', 'USDC\u2800', 'PE\uFFF9PE', 'US\uDB40\uDC41DC', 'PE\uDB40\uDD00PE', 'PE\uD834\uDD73PE', 'PE\uD82F\uDCA0PE']) danger(symbol)
    // look-alike blocks: Roman numerals, Latin Extended-D small capitals, enclosed supplement, Tifinagh, Vai, Deseret, Osage, Old Italic, Warang Citi, Georgian look-alikes
    for (const symbol of ['\u216FE\u216FE', 'U\uA731DC', '\uA731OL', '\uD83C\uDD64\uD83C\uDD62\uD83C\uDD53\uD83C\uDD52', '\u2D54KB', 'W\uA557TC', 'USD\uD801\uDC15', '\uD801\uDCC2KB', 'W\uD800\uDF01TC', '\uD806\uDCA0ET', '\u10BDOL']) danger(symbol)
    // leading spaces do not push a look-alike out of what is checked
    danger(`${' '.repeat(200)}РЕРЕ`)
    danger(`${'\u3000'.repeat(200)}ΑΒΓ`)
    // emoji stay a caution: ™ and the tag-sequence flags; Persian spelling with ZWNJ; Georgian that passes for nothing
    for (const symbol of ['PEPE™', 'PEPE\u2122\uFE0F', 'PEPE\u2120', 'GB\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62\uDB40\uDC65\uDB40\uDC6E\uDB40\uDC67\uDB40\uDC7F', '\u0645\u06CC\u200C\u0634\u0648\u062F', '\u10E5\u10D0\u10E0\u10D7']) caution(symbol)
    // a stray ZWNJ next to Latin letters still hides
    danger('PE\u200CPE')
    // a spacing accent folds away: "USDC´" is USDC
    expect(risk(info({ symbol: 'USDC\u00B4' }), 'impersonation')).toBeDefined()
    expect(risk(info({ symbol: 'US\u0000DC' }), 'impersonation')).toBeDefined() // fold sees through the control too
  })
})
