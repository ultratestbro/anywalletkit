import type { TokenFlag, TokenInfo } from '@anywalletkit/core'
import { CC_SOURCE_CHAINS, catalogChainId, ccChain } from '@anywalletkit/swap2-assets'

/** `danger`: the token can take or trap the user's money, or pretends to be another one. `caution`: worth knowing. */
export type TokenRiskLevel = 'danger' | 'caution'

/**
 * Why a token deserves a warning:
 * - `unlisted`: always — the wallet's list does not include it, and anyone can deploy a token with any name and logo.
 * - `impersonation`: its symbol reads as a known token's (USDC, ETH, …), look-alike letters included.
 * - `odd-characters`: its symbol or name uses characters outside plain ASCII, or invisible ones.
 * - `no-symbol`: it reports no symbol.
 * - `zero-supply`: nothing has been minted.
 * - `unusual-decimals`: more than 24 decimals.
 * - a {@link TokenFlag} read from the chain (issuer powers, Token-2022 extensions).
 */
export type TokenRiskCode = 'unlisted' | 'impersonation' | 'odd-characters' | 'no-symbol' | 'zero-supply' | 'unusual-decimals' | TokenFlag

/** One warning, worded for the person adding the token. */
export interface TokenRisk {
  code: TokenRiskCode
  level: TokenRiskLevel
  message: string
}

/** Every warning that applies, worst first, and the worst level. A user token is never "safe": `caution` is the floor. */
export interface TokenAssessment {
  level: TokenRiskLevel
  risks: TokenRisk[]
}

const FLAG_RISKS: Readonly<Record<TokenFlag, { level: TokenRiskLevel; message: string }>> = {
  'upgradeable': { level: 'caution', message: "The token's owner can replace its code." },
  'mint-authority': { level: 'caution', message: 'The issuer can mint more at any time.' },
  'freeze-authority': { level: 'caution', message: 'The issuer can freeze your balance.' },
  'permanent-delegate': { level: 'danger', message: 'The issuer can move or burn the tokens in your wallet.' },
  'transfer-fee': { level: 'caution', message: 'Every transfer pays a fee to the issuer.' },
  'transfer-hook': { level: 'danger', message: "A program of the issuer's choosing runs on every transfer: it can block selling." },
  'non-transferable': { level: 'danger', message: 'It cannot be moved: not sent, not swapped.' },
  'default-frozen': { level: 'caution', message: 'New holders start frozen until the issuer lets them move it.' },
  'pausable': { level: 'caution', message: 'The issuer can pause every transfer.' },
}

/** Longest symbol the wallet stores and assesses (code points); a longer one is cut, after trimming, before anything reads it. */
export const TOKEN_SYMBOL_MAX = 32
/** Longest name the wallet stores (code points). */
export const TOKEN_NAME_MAX = 128

/**
 * A symbol or name as the wallet keeps and shows it: trimmed, cut to `max` code points, trimmed again —
 * so "USDC" + 124 spaces + "X" is stored, shown and assessed as "USDC" (scan 2026-10-27 modules, F28).
 */
export function tokenText(text: string, max: number): string {
  let out = ''
  let n = 0
  for (const ch of text.trim()) {
    if (n++ >= max) break
    out += ch
  }
  return out.trim()
}

/** Letters that render like Latin capitals (Cyrillic, Greek) and currency signs used as letters. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'Ԁ': 'D',
  'а': 'A', 'в': 'B', 'е': 'E', 'к': 'K', 'м': 'M', 'н': 'H', 'о': 'O', 'р': 'P', 'с': 'C', 'т': 'T', 'х': 'X', 'у': 'Y', 'і': 'I', 'ј': 'J', 'ѕ': 'S', 'ԁ': 'D',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'α': 'A', 'ε': 'E', 'ι': 'I', 'κ': 'K', 'ν': 'V', 'ο': 'O', 'ρ': 'P', 'τ': 'T', 'υ': 'U', 'χ': 'X',
  '$': 'S', '₮': 'T', '€': 'E', '¢': 'C', '₿': 'B', 'Ξ': 'E',
  // ASCII and Latin look-alikes of I and O (UTS #39 confusables): "DAl" reads as DAI, "USDl" as USD1.
  'l': 'I', '1': 'I', '|': 'I', 'ı': 'I', 'ł': 'I', 'ǀ': 'I', '0': 'O', 'ø': 'O', 'Ø': 'O',
  // Latin letters without a decomposition, and Latin-1 accented letters for runtimes without String.prototype.normalize.
  'Ð': 'D', 'ð': 'D', 'Đ': 'D', 'đ': 'D', 'Ħ': 'H', 'ħ': 'H', 'Ŧ': 'T', 'ŧ': 'T', 'ß': 'B', 'Þ': 'P', 'þ': 'P', 'Ŋ': 'N', 'ŋ': 'N',
  'À': 'A', 'Á': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'Å': 'A', 'à': 'A', 'á': 'A', 'â': 'A', 'ã': 'A', 'ä': 'A', 'å': 'A',
  'Ç': 'C', 'ç': 'C', 'È': 'E', 'É': 'E', 'Ê': 'E', 'Ë': 'E', 'è': 'E', 'é': 'E', 'ê': 'E', 'ë': 'E',
  'Ì': 'I', 'Í': 'I', 'Î': 'I', 'Ï': 'I', 'ì': 'I', 'í': 'I', 'î': 'I', 'ï': 'I', 'Ñ': 'N', 'ñ': 'N',
  'Ò': 'O', 'Ó': 'O', 'Ô': 'O', 'Õ': 'O', 'Ö': 'O', 'ò': 'O', 'ó': 'O', 'ô': 'O', 'õ': 'O', 'ö': 'O',
  'Ù': 'U', 'Ú': 'U', 'Û': 'U', 'Ü': 'U', 'ù': 'U', 'ú': 'U', 'û': 'U', 'ü': 'U', 'Ý': 'Y', 'ý': 'Y', 'ÿ': 'Y',
}
/** Letter pairs that read as one letter (UTS #39): rn → m, cl → d, vv → w. */
const PAIRS: ReadonlyArray<[RegExp, string]> = [[/rn/g, 'm'], [/cl/g, 'd'], [/vv|VV/g, 'W']]
/** Combining marks: an accent over a Latin letter reads as the letter. */
const MARKS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g
/**
 * Characters a reader does not see: zero-width, bidi and other format characters, C0 / C1 controls,
 * fillers and blank glyphs (Hangul fillers, U+2800 braille blank), interlinear annotation, and the
 * astral ones — tag characters (ASCII smuggling), variation selectors 17–256, musical and shorthand
 * format controls. Explicit ranges: Hermes has no Unicode property escapes.
 */
const INVISIBLE = /[\x00-\x08\x0E-\x1F\x7F-\x9F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F\uDD00-\uDDEF]|\uD834[\uDD59\uDD73-\uDD7A]|\uD82F[\uDCA0-\uDCA3]/g

/**
 * A symbol folded the way a reader sees it — a confusables skeleton in the spirit of UTS #39: invisible
 * characters and spaces gone, compatibility forms unified and accents dropped (NFKD), look-alike letters
 * mapped (Cyrillic, Greek, currency signs, and ASCII l / 1 / | → I, 0 → O; rn → m, cl → d, vv → w), upper
 * case. Only the first {@link TOKEN_SYMBOL_MAX} code points are read (scan 2026-10-27 modules, F36).
 */
export function foldSymbol(text: string): string {
  let s = tokenText(text, TOKEN_SYMBOL_MAX).replace(INVISIBLE, '')
  if (typeof s.normalize === 'function') s = s.normalize('NFKD').replace(MARKS, '')
  // After NFKD: a spacing accent (´ ¨ ¸ ‾) decomposes into a space and a mark.
  s = s.replace(/\s+/g, '')
  // Fullwidth ASCII by hand too: some Hermes builds ship without String.prototype.normalize.
  s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  for (const [re, to] of PAIRS) s = s.replace(re, to)
  let out = ''
  for (const ch of s) out += CONFUSABLES[ch] ?? ch
  return out.toUpperCase()
}

/** Symbols nobody should reuse on any chain: the big stablecoins and wrapped coins (natives are added from the catalog). */
const MAJOR_TOKENS = ['USDT', 'USDC', 'DAI', 'USDe', 'USDS', 'PYUSD', 'FDUSD', 'USD1', 'USDG', 'EURC', 'WETH', 'WBTC', 'cbBTC', 'stETH', 'wstETH', 'WSOL']

let majors: ReadonlyMap<string, string> | undefined
/** Folded → display: every chain's native coin from the catalog, plus {@link MAJOR_TOKENS}. */
function majorSymbols(): ReadonlyMap<string, string> {
  if (majors) return majors
  const m = new Map<string, string>()
  for (const chain of CC_SOURCE_CHAINS) for (const a of chain.assets) if (!a.contract && !m.has(foldSymbol(a.symbol))) m.set(foldSymbol(a.symbol), a.symbol)
  for (const sym of MAJOR_TOKENS) if (!m.has(foldSymbol(sym))) m.set(foldSymbol(sym), sym)
  majors = m
  return m
}

/** The known token a folded symbol reads as: any catalog token on the same chain, or a major one anywhere. */
function lookalikeOf(folded: string, chain: string | undefined): string | undefined {
  if (!folded) return undefined
  if (chain) {
    const same = ccChain(catalogChainId(chain))?.assets.find((a) => foldSymbol(a.symbol) === folded)
    if (same) return same.symbol
  }
  return majorSymbols().get(folded)
}

const PLAIN = /^[\x20-\x7E]*$/
/**
 * Letters that pass for Latin ones, by block (the whole block, as for Cyrillic): IPA and spacing
 * modifier letters, Greek, Cyrillic, Armenian, Cherokee, Canadian syllabics, runic, phonetic letters
 * and small capitals (also Latin Extended-D / E), letterlike symbols (ℂ ℍ ℕ — not ™ ℠ ℗), Roman
 * numerals, enclosed letters and digits (Ⓤ ①, 🅤), Coptic, Tifinagh, Lisu, Vai, mathematical letters
 * (𝐔) and the astral Deseret, Osage, Lycian, Carian, Old Italic and Warang Citi; for Georgian, a living
 * script, only its look-alike letters (Ⴝ ყ ჿ Ჽ ⴭ…). Explicit ranges: Hermes has no Unicode property
 * escapes. Emoji, CJK, Arabic, Hebrew, Thai and accented Latin are not here: a caution, not a danger.
 */
const LOOKALIKE_LETTERS = /[\u0250-\u02FF\u0370-\u03FF\u0400-\u052F\u0530-\u058F\u10B9\u10BD\u10C7\u10CD\u10E7\u10FD\u10FF\u13A0-\u13FF\u1400-\u167F\u16A0-\u16FF\u1C80-\u1C8F\u1C95\u1CB7\u1CBD\u1CBF\u1D00-\u1DBF\u1F00-\u1FFF\u2100-\u2116\u2118-\u211F\u2121\u2123-\u214F\u2160-\u2188\u2460-\u24FF\u2C80-\u2CFF\u2D2D\u2D30-\u2D7F\u2DE0-\u2DFF\uA4D0-\uA4FF\uA500-\uA63F\uA640-\uA69F\uA720-\uA7FF\uAB30-\uABBF]|\uD835[\uDC00-\uDFFF]|\uD83C[\uDD10-\uDD69]|\uD801[\uDC00-\uDC4F\uDCB0-\uDCFF]|\uD800[\uDE80-\uDEDF\uDF00-\uDF2F]|\uD806[\uDCA0-\uDCFF]/
/**
 * What hides inside text: {@link INVISIBLE} without the joiner and the variation selectors 1–16
 * emoji are built with.
 */
const HIDING = /[\x00-\x08\x0E-\x1F\x7F-\x9F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F\uDD00-\uDDEF]|\uD834[\uDD59\uDD73-\uDD7A]|\uD82F[\uDCA0-\uDCA3]/
/** A line break inside a symbol: what follows it is on a line a one-line label does not show. */
const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/
/** Emoji built from tag characters (the England, Scotland and Wales flags) are emoji, not hidden text. */
const EMOJI_TAG_SEQUENCE = /\uD83C\uDFF4(?:\uDB40[\uDC20-\uDC7E])+\uDB40\uDC7F/g
/** Zero-width non-joiner between two non-ASCII characters is spelling (Persian, Indic scripts), not hiding. */
const SPELLING_ZWNJ = /([^\x00-\x7F])\u200C(?=[^\x00-\x7F])/g
/** Letters that pass for Latin ones, or characters that hide, in `text`. */
const passesOrHides = (text: string): boolean => LOOKALIKE_LETTERS.test(text) || HIDING.test(text.replace(EMOJI_TAG_SEQUENCE, '').replace(SPELLING_ZWNJ, '$1'))


/**
 * Warnings for a token read with `getTokenInfo`, for a token the wallet's list does not include.
 * Pure: nothing is fetched. `impersonation` when its symbol (look-alike letters folded) reads as a
 * catalog token on the same `chain` — the real one would be in the list, this is another contract —
 * or as a native coin or major stablecoin anywhere. A bridged token of another chain's list (JUP on
 * Solana, listed on Unichain) is not flagged.
 */
export function assessToken(info: TokenInfo, chain?: string): TokenAssessment {
  const risks: TokenRisk[] = [{ code: 'unlisted', level: 'caution', message: "Not in the wallet's token list. Anyone can create a token with any name and logo: check the address with the project itself." }]
  // What the wallet stores and shows (trimmed, cut to TOKEN_SYMBOL_MAX), and the whole text a UI that does
  // not cut it would show: a look-alike in either is one (scan 2026-10-27 modules, F28).
  const symbol = tokenText(info.symbol, TOKEN_SYMBOL_MAX)
  const name = tokenText(info.name, TOKEN_NAME_MAX)
  const whole = info.symbol.slice(0, 4 * TOKEN_SYMBOL_MAX).replace(/\s+/g, '')
  const lookalike = lookalikeOf(foldSymbol(symbol), chain) ?? lookalikeOf(foldSymbol(whole), chain)
  if (lookalike) {
    risks.push({ code: 'impersonation', level: 'danger', message: `It calls itself ${JSON.stringify(symbol)}, like ${lookalike}, but it is a different token at a different address.` })
  }
  // The raw head (what a host showing the raw symbol shows) and the stored symbol (what this wallet shows):
  // leading spaces must not push the look-alike out of the part that is checked.
  const head = info.symbol.slice(0, 4 * TOKEN_SYMBOL_MAX)
  if (passesOrHides(head) || passesOrHides(symbol) || LINE_BREAK.test(symbol)) {
    // Letters of another alphabet that pass for Latin ones, or characters that hide, are how a token passes for a
    // known one (scan 2026-10-27 modules, F36). Emoji, CJK and accented Latin stay a caution (owner decision 2026-10-28).
    risks.push({ code: 'odd-characters', level: 'danger', message: 'Its symbol uses letters of another alphabet that pass for Latin ones (Cyrillic, Greek…) or characters that hide in text.' })
  } else if (!PLAIN.test(symbol) || /\s/.test(symbol) || !PLAIN.test(name) || name !== name.replace(INVISIBLE, '')) {
    risks.push({ code: 'odd-characters', level: 'caution', message: 'Its symbol or name uses unusual characters (emoji, other scripts, accents), spaces inside the symbol, or invisible ones.' })
  }
  if (!symbol) risks.push({ code: 'no-symbol', level: 'caution', message: 'The token reports no symbol.' })
  if (info.totalSupply === 0n) risks.push({ code: 'zero-supply', level: 'caution', message: 'Nothing has been minted.' })
  if (info.decimals > 24) risks.push({ code: 'unusual-decimals', level: 'caution', message: `It uses ${info.decimals} decimals; amounts may display oddly.` })
  for (const flag of info.flags) {
    const r = FLAG_RISKS[flag]
    if (r) risks.push({ code: flag, ...r })
  }
  risks.sort((a, b) => (a.level === b.level ? 0 : a.level === 'danger' ? -1 : 1))
  return { level: risks.some((r) => r.level === 'danger') ? 'danger' : 'caution', risks }
}
