import { ccChain } from '@anywalletkit/swap2-assets'

export interface TokenMeta {
  symbol: string
  decimals: number
}

const metaCache = new Map<number, Map<string, TokenMeta>>()
const symbolCache = new Map<number, Set<string>>()

function index(chainId: number): Map<string, TokenMeta> {
  let m = metaCache.get(chainId)
  if (m) return m
  m = new Map()
  const chain = ccChain(`eip155:${chainId}`)
  for (const a of chain?.assets ?? []) {
    if (a.contract) m.set(a.contract.toLowerCase(), { symbol: a.symbol, decimals: a.decimals })
  }
  metaCache.set(chainId, m)
  return m
}

/** Symbol / decimals of a token the swap2 asset catalog knows on this chain. */
export function catalogToken(chainId: number, token: string): TokenMeta | undefined {
  return index(chainId).get(token.toLowerCase())
}

/** Upper-cased symbols of every catalog token on the chain (native included), for the impersonation rule. */
export function catalogSymbols(chainId: number): Set<string> {
  let s = symbolCache.get(chainId)
  if (s) return s
  s = new Set()
  const chain = ccChain(`eip155:${chainId}`)
  for (const a of chain?.assets ?? []) s.add(a.symbol.toUpperCase())
  symbolCache.set(chainId, s)
  return s
}
