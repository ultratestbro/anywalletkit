import type { IWalletAccountReadOnly, TokenFlag, TokenInfo } from '@anywalletkit/core'
import { catalogChainId, ccAssetByToken, isTokenAddress, type CcAsset } from '@anywalletkit/swap2-assets'
import { TOKEN_NAME_MAX, TOKEN_SYMBOL_MAX, assessToken, tokenText, type TokenAssessment } from './assess.js'

/** One JSON value under one key — the shape every small store needs (AsyncStorage, chrome.storage, memory). */
export interface JsonStorage<T> {
  /** The stored value, or `null` on first run. */
  get(): Promise<T | null>
  /** Persist the value. */
  set(value: T): Promise<void>
}

/** In-memory storage for tests and smoke runs. */
export function memoryJsonStorage<T>(initial: T | null = null): JsonStorage<T> & { value: T | null } {
  const clone = (v: T): T => JSON.parse(JSON.stringify(v)) as T
  const s = {
    value: initial,
    async get() { return s.value === null ? null : clone(s.value) },
    async set(value: T) { s.value = clone(value) },
  }
  return s
}

/** A token the user added. `symbol` and `name` are what the token reports: display them, never match on them. */
export interface UserToken {
  /** CAIP-2 chain id, the catalog's key (`solana:mainnet`, `eip155:1`). */
  chain: string
  /** Contract (EVM, checksummed as read) or mint (Solana). The token's identity. */
  address: string
  symbol: string
  name: string
  decimals: number
  /** `erc20`, `spl` or `spl-token-2022`. */
  standard: string
  /** Facts read from the chain when it was added. */
  flags: TokenFlag[]
  /** When the user added it (ms since epoch). */
  addedAt: number
}

/** What {@link TokensTable} stores. */
export interface TokensState {
  v: 1
  tokens: UserToken[]
}

/** Codes of {@link TokensError}. */
export type TokensErrorCode = 'not-loaded' | 'unsupported-chain' | 'bad-address' | 'listed' | 'bad-token' | 'full'

/** A refusal from the tokens table or {@link inspectToken}, with a machine-readable `code`. */
export class TokensError extends Error {
  readonly code: TokensErrorCode
  constructor(code: TokensErrorCode, message: string) {
    super(message)
    this.name = 'TokensError'
    this.code = code
  }
}

const sameAddress = (chain: string, a: string, b: string) => (chain.startsWith('eip155:') ? a.toLowerCase() === b.toLowerCase() : a === b)
const FLAGS: ReadonlySet<string> = new Set<TokenFlag>(['upgradeable', 'mint-authority', 'freeze-authority', 'permanent-delegate', 'transfer-fee', 'transfer-hook', 'non-transferable', 'default-frozen', 'pausable'])

/** A stored entry as it must be, or null (a hand-edited or corrupted entry is dropped, never trusted). */
function validEntry(t: unknown): UserToken | null {
  if (!t || typeof t !== 'object') return null
  const e = t as Record<string, unknown>
  if (typeof e.chain !== 'string' || typeof e.address !== 'string' || !isTokenAddress(e.chain, e.address)) return null
  if (typeof e.decimals !== 'number' || !Number.isInteger(e.decimals) || e.decimals < 0 || e.decimals > 77) return null
  if (typeof e.symbol !== 'string' || typeof e.name !== 'string' || typeof e.standard !== 'string' || typeof e.addedAt !== 'number') return null
  if (!Array.isArray(e.flags) || !e.flags.every((f) => typeof f === 'string' && FLAGS.has(f))) return null
  return {
    chain: e.chain, address: e.address, symbol: tokenText(e.symbol, TOKEN_SYMBOL_MAX), name: tokenText(e.name, TOKEN_NAME_MAX), decimals: e.decimals,
    standard: e.standard, flags: [...e.flags] as TokenFlag[], addedAt: e.addedAt,
  }
}

/** The result of looking a token up before adding it. */
export type TokenInspection =
  | { listed: CcAsset }
  | { listed?: undefined; info: TokenInfo; assessment: TokenAssessment; token: UserToken }

/**
 * Read a token from the chain through `account` (its chain decides where) and assess it. A token the
 * catalog already lists comes back as `{ listed }`: nothing to add. Otherwise the token, ready for
 * {@link TokensTable.add}, and the warnings to show first. Throws {@link TokensError}
 * (`unsupported-chain`, `bad-address`) or the chain package's `NotATokenError`.
 */
export async function inspectToken(
  account: Pick<IWalletAccountReadOnly, 'chain' | 'getTokenInfo'> & { getChainId?: () => Promise<number | bigint> },
  address: string,
  now: () => number = Date.now,
): Promise<TokenInspection> {
  let reported = account.chain
  // An EVM account created without a chain id reports 'eip155:unknown' until it has asked its RPC:
  // ask now, or the catalog check (already listed? a look-alike of this chain's tokens?) would miss.
  if (reported === 'eip155:unknown') {
    if (typeof account.getChainId !== 'function') throw new TokensError('unsupported-chain', 'The account does not know its chain id; create it with chainId.')
    reported = `eip155:${String(await account.getChainId())}`
  }
  const chain = catalogChainId(reported)
  if (!chain.startsWith('eip155:') && !chain.startsWith('solana:')) throw new TokensError('unsupported-chain', `Adding tokens is supported on EVM chains and Solana, not ${account.chain}.`)
  const ref = address.trim()
  if (!isTokenAddress(chain, ref)) throw new TokensError('bad-address', `${JSON.stringify(address)} is not a token address on ${chain}.`)
  const listed = ccAssetByToken(chain, ref)
  if (listed) return { listed }
  if (typeof account.getTokenInfo !== 'function') throw new TokensError('unsupported-chain', `This ${account.chain} account cannot read token info.`)
  const info = await account.getTokenInfo(ref)
  // What is stored is what is assessed: trimmed and cut first (scan 2026-10-27 modules, F28).
  const symbol = tokenText(info.symbol, TOKEN_SYMBOL_MAX)
  const name = tokenText(info.name, TOKEN_NAME_MAX)
  const token: UserToken = {
    chain, address: info.address, symbol, name, decimals: info.decimals,
    standard: info.standard, flags: [...info.flags], addedAt: now(),
  }
  return { info, assessment: assessToken({ ...info, symbol, name }, chain), token }
}

/**
 * The swap options that name a user token as the source: its address and decimals. Pass them to an
 * engine created with `allowUnlistedTokens: true`.
 */
export function swapSource(token: Pick<UserToken, 'address' | 'decimals'>): { fromToken: string; fromTokenDecimals: number } {
  return { fromToken: token.address, fromTokenDecimals: token.decimals }
}

/**
 * The user's own tokens, over any JSON storage: load once at cold start, then read synchronously.
 * Writes queue behind each other; a failed save leaves memory as stored. Tokens the catalog lists are
 * refused (they are already there), and so are addresses that are not EVM contracts or Solana mints.
 */
export class TokensTable {
  private _state: TokensState | null = null
  private _loading: Promise<TokensState> | null = null
  private _writes: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  readonly maxTokens: number

  constructor(private readonly storage: JsonStorage<TokensState>, options: { maxTokens?: number } = {}) {
    this.maxTokens = options.maxTokens ?? 200
  }

  /** Read the stored list. Call once before the sync reads; a failed read throws and leaves the table unloaded. */
  async load(): Promise<void> {
    await this.state()
  }

  /** Called after every successful write. Returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** The user's tokens, oldest first; only those on `chain` when given. */
  list(chain?: string): UserToken[] {
    const s = this.loaded()
    const want = chain === undefined ? undefined : catalogChainId(chain)
    return s.tokens.filter((t) => want === undefined || t.chain === want).map((t) => ({ ...t, flags: [...t.flags] }))
  }

  /** The user token at `address` on `chain`, if added. */
  get(chain: string, address: string): UserToken | undefined {
    const c = catalogChainId(chain)
    const t = this.loaded().tokens.find((x) => x.chain === c && sameAddress(c, x.address, address))
    return t ? { ...t, flags: [...t.flags] } : undefined
  }

  /** Add (or refresh) a token — usually `inspection.token` after the user accepted the warnings. */
  async add(token: UserToken): Promise<UserToken> {
    const entry = validEntry({ ...token, chain: catalogChainId(token.chain) })
    if (!entry) throw new TokensError('bad-token', 'Not a valid token entry (address, decimals 0–77, symbol, name, standard, flags).')
    if (ccAssetByToken(entry.chain, entry.address)) throw new TokensError('listed', `${entry.address} is already in the wallet's token list.`)
    await this.update((s) => {
      const rest = s.tokens.filter((t) => !(t.chain === entry.chain && sameAddress(entry.chain, t.address, entry.address)))
      if (rest.length >= this.maxTokens) throw new TokensError('full', `At most ${this.maxTokens} tokens can be added.`)
      return { v: 1, tokens: [...rest, entry] }
    })
    return { ...entry, flags: [...entry.flags] }
  }

  /** Remove a token. Returns whether it was there. */
  async remove(chain: string, address: string): Promise<boolean> {
    const c = catalogChainId(chain)
    let removed = false
    await this.update((s) => {
      const rest = s.tokens.filter((t) => !(t.chain === c && sameAddress(c, t.address, address)))
      removed = rest.length !== s.tokens.length
      return { v: 1, tokens: rest }
    })
    return removed
  }

  private loaded(): TokensState {
    if (!this._state) throw new TokensError('not-loaded', 'Call load() before reading the tokens table.')
    return this._state
  }

  private async state(): Promise<TokensState> {
    if (this._state) return this._state
    this._loading ??= (async () => {
      let stored: TokensState | null
      try {
        stored = await this.storage.get()
      } catch (e) {
        // A failed read is not an empty list: the next write would erase the user's tokens.
        this._loading = null
        throw e
      }
      const tokens = stored && stored.v === 1 && Array.isArray(stored.tokens)
        ? stored.tokens.map(validEntry).filter((t): t is UserToken => t !== null)
        : []
      this._state = { v: 1, tokens }
      return this._state
    })()
    return this._loading
  }

  private update(change: (s: TokensState) => TokensState): Promise<void> {
    const run = this._writes.then(async () => {
      const next = change(await this.state())
      await this.storage.set(next)
      this._state = next
      for (const fn of this.listeners) {
        try { fn() } catch { /* a listener's failure is its own */ }
      }
    })
    this._writes = run.catch(() => undefined)
    return run
  }
}
