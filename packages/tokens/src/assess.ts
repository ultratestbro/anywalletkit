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

/** Letters that render like Latin capitals (Cyrillic, Greek) and currency signs used as letters. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'Ԁ': 'D',
  'а': 'A', 'в': 'B', 'е': 'E', 'к': 'K', 'м': 'M', 'н': 'H', 'о': 'O', 'р': 'P', 'с': 'C', 'т': 'T', 'х': 'X', 'у': 'Y', 'і': 'I', 'ј': 'J', 'ѕ': 'S', 'ԁ': 'D',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'α': 'A', 'ε': 'E', 'ι': 'I', 'κ': 'K', 'ν': 'V', 'ο': 'O', 'ρ': 'P', 'τ': 'T', 'υ': 'U', 'χ': 'X',
  '$': 'S', '₮': 'T', '€': 'E', '¢': 'C', '₿': 'B', 'Ξ': 'E',
}
/** Zero-width, bidi and other invisible format characters. */
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g

/** A symbol folded the way a reader sees it: invisible characters gone, compatibility forms unified, look-alikes mapped, upper case. */
export function foldSymbol(text: string): string {
  let s = text.replace(INVISIBLE, '').replace(/\s+/g, '')
  if (typeof s.normalize === 'function') s = s.normalize('NFKC')
  // Fullwidth ASCII by hand too: some Hermes builds ship without String.prototype.normalize.
  s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
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
 * Warnings for a token read with `getTokenInfo`, for a token the wallet's list does not include.
 * Pure: nothing is fetched. `impersonation` when its symbol (look-alike letters folded) reads as a
 * catalog token on the same `chain` — the real one would be in the list, this is another contract —
 * or as a native coin or major stablecoin anywhere. A bridged token of another chain's list (JUP on
 * Solana, listed on Unichain) is not flagged.
 */
export function assessToken(info: TokenInfo, chain?: string): TokenAssessment {
  const risks: TokenRisk[] = [{ code: 'unlisted', level: 'caution', message: "Not in the wallet's token list. Anyone can create a token with any name and logo: check the address with the project itself." }]
  const folded = foldSymbol(info.symbol)
  const lookalike = lookalikeOf(folded, chain)
  if (lookalike) {
    risks.push({ code: 'impersonation', level: 'danger', message: `It calls itself ${JSON.stringify(info.symbol)}, like ${lookalike}, but it is a different token at a different address.` })
  }
  if (!PLAIN.test(info.symbol) || !PLAIN.test(info.name) || info.symbol !== info.symbol.replace(INVISIBLE, '') || info.name !== info.name.replace(INVISIBLE, '')) {
    risks.push({ code: 'odd-characters', level: 'caution', message: 'Its symbol or name uses characters that can look like other letters, or invisible ones.' })
  }
  if (!info.symbol.trim()) risks.push({ code: 'no-symbol', level: 'caution', message: 'The token reports no symbol.' })
  if (info.totalSupply === 0n) risks.push({ code: 'zero-supply', level: 'caution', message: 'Nothing has been minted.' })
  if (info.decimals > 24) risks.push({ code: 'unusual-decimals', level: 'caution', message: `It uses ${info.decimals} decimals; amounts may display oddly.` })
  for (const flag of info.flags) {
    const r = FLAG_RISKS[flag]
    if (r) risks.push({ code: flag, ...r })
  }
  risks.sort((a, b) => (a.level === b.level ? 0 : a.level === 'danger' ? -1 : 1))
  return { level: risks.some((r) => r.level === 'danger') ? 'danger' : 'caution', risks }
}
