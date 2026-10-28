// Plumbing both Kamino protocols share: the API client, the account's
// serialized-transaction guard (programs allowlist, the operation's
// instruction rules and a simulated balance proof), chain reads, decimals,
// and the expectation builders that bound what a built transaction may do
// with the wallet's balances.
import { LendingProtocol, type IWalletAccount, type IWalletAccountReadOnly } from '@anywalletkit/core'
import { KaminoApi } from './api.js'
import type { ChainAccount } from './chain.js'
import { KaminoError } from './errors.js'
import type { InstructionRule } from './policy.js'
import { KAMINO_PROGRAM_ALLOWLIST } from './programs.js'

export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
export const WSOL_MINT = 'So11111111111111111111111111111111111111112'
/** SOL allowance for rent (ATAs, farm user state) and priority fees on top of the amount itself. */
export const DEFAULT_RENT_ALLOWANCE = 10_000_000n
/** Extra SOL a first Lend deposit needs: obligation (~0.024), user metadata, lookup table, ATAs. */
export const DEFAULT_FIRST_DEPOSIT_ALLOWANCE = 45_000_000n

/** Decimals of mints Kamino lists, for accounts that cannot read mints (fixtures, read-only without RPC). */
export const KNOWN_DECIMALS: Readonly<Record<string, number>> = Object.freeze({
  [WSOL_MINT]: 9,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 6, // PYUSD
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH': 6, // USDG
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 8, // ETH (Wormhole)
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 8, // WBTC
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: 8, // cbBTC
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 9, // JitoSOL
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 9, // mSOL
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: 9, // jupSOL
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: 9, // bSOL
  KMNoPBQmDoVB7cQgqu5bufCPRChRMj3P4MaE8DxGZCz: 6, // KMNO
})

export interface KaminoBaseConfig {
  /** API endpoint or a prepared client (default api.kamino.finance). */
  api?: string | KaminoApi
  /** fetch implementation for the API (default global fetch). */
  fetch?: typeof fetch
  /** Per-call timeout for the API, in ms (default 15 000). Ignored when `api` is a prepared client. */
  timeoutMs?: number
  /** Tolerance on what the wallet must receive on withdrawals / borrows, in basis points (default 50). */
  slippageBps?: number
  /** SOL the transaction may spend on rent and fees beyond the amount (default 0.01 SOL). */
  rentAllowanceLamports?: bigint | number
  /** SPL memo (≤ 64 bytes) the API adds to every transaction. */
  memo?: string
}

/** What the guard proves before signing (mirrors wallet-solana's `SerializedExpectation`). */
export interface Expectation {
  maxLamportsOut: bigint
  tokenIn?: { mint: string; minAmount: bigint; maxAmount?: bigint }
  maxTokenOut?: { mint: string; amount: bigint }
}

export interface SerializedGuard { programAllowlist: readonly string[]; instructions: readonly InstructionRule[]; expect: Expectation }

/** The surface of a `@anywalletkit/wallet-solana` account this module needs. */
export interface SolanaAccountSurface {
  getAddress(): Promise<string>
  checkSerialized?(base64: string, guard: SerializedGuard): Promise<{ quote: { fee: bigint } }>
  sendSerialized?(base64: string, guard: SerializedGuard): Promise<{ hash: string; fee: bigint }>
  getMintInfo?(mint: string): Promise<{ decimals: number }>
  /** Raw accounts in the order asked (wallet-solana 0.4+): the chain state the API's figures are checked against. */
  getAccountInfos?(addresses: readonly string[]): Promise<Array<ChainAccount | null>>
}

export abstract class KaminoBase<TConfig extends KaminoBaseConfig> extends LendingProtocol<TConfig> {
  readonly api: KaminoApi
  protected readonly slippageBps: number
  protected readonly rentAllowance: bigint
  private readonly _decimals = new Map<string, Promise<number>>()

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig) {
    super(account, config ?? ({} as TConfig))
    const c = this._config
    this.api = c.api instanceof KaminoApi ? c.api : new KaminoApi(c.api, c.fetch, c.timeoutMs)
    this.slippageBps = c.slippageBps ?? 50
    if (!Number.isInteger(this.slippageBps) || this.slippageBps < 0 || this.slippageBps > 5_000) throw new KaminoError("'slippageBps' must be an integer between 0 and 5000.")
    this.rentAllowance = c.rentAllowanceLamports === undefined ? DEFAULT_RENT_ALLOWANCE : BigInt(c.rentAllowanceLamports)
    const chain = account?.chain
    if (chain && chain.startsWith('solana:') && chain !== SOLANA_MAINNET) throw new KaminoError(`Kamino lives on Solana mainnet; the account is on ${chain}.`)
  }

  /** Refuse anything that is not a mainnet Solana account before an API call is made in its name. */
  protected requireSolana(): void {
    const chain = this._account?.chain
    if (chain && chain !== SOLANA_MAINNET) throw new KaminoError(`Kamino needs a Solana mainnet account (${SOLANA_MAINNET}); this one is on ${chain}.`)
  }

  protected surface(): SolanaAccountSurface {
    return this._account as unknown as SolanaAccountSurface
  }

  protected async me(): Promise<string> {
    this.requireSolana()
    return this._account.getAddress()
  }

  /** Mint decimals: the account reads the mint when it can; well-known mints need no RPC. */
  protected decimals(mint: string): Promise<number> {
    let p = this._decimals.get(mint)
    if (!p) {
      p = (async () => {
        const known = KNOWN_DECIMALS[mint]
        const s = this.surface()
        if (typeof s.getMintInfo === 'function') {
          try { return (await s.getMintInfo(mint)).decimals } catch (e) { if (known !== undefined) return known; throw e }
        }
        if (known !== undefined) return known
        throw new KaminoError(`Cannot read the decimals of ${mint}: the account has no RPC and the mint is not a known one.`)
      })().catch((e) => { this._decimals.delete(mint); throw e })
      this._decimals.set(mint, p)
    }
    return p
  }

  protected guard(expect: Expectation, instructions: readonly InstructionRule[]): SerializedGuard {
    if (!instructions.length) throw new KaminoError('A Kamino transaction is checked against the instructions its operation takes; none were given.')
    return { programAllowlist: KAMINO_PROGRAM_ALLOWLIST, instructions, expect }
  }

  /** Accounts from the chain through the wallet's RPC, in the order asked (null where none exists). */
  protected async readChain(addresses: readonly string[]): Promise<Array<ChainAccount | null>> {
    const s = this.surface()
    if (typeof s.getAccountInfos !== 'function') throw new KaminoError('Kamino checks the API against the chain: it needs a @anywalletkit/wallet-solana account (getAccountInfos).')
    const out = await s.getAccountInfos(addresses)
    if (!Array.isArray(out) || out.length !== addresses.length) throw new KaminoError('The account returned a different number of accounts than asked.')
    return out
  }

  /** The wallet sends `amount` of `mint` (SOL counts on the lamport side) and may lose rent on top. */
  protected spendExpectation(mint: string, amount: bigint, extraLamports = 0n): Expectation {
    if (amount <= 0n) throw new KaminoError(`Refusing a transaction that spends ${amount} of ${mint}: the amount must be positive.`)
    const rent = this.rentAllowance + extraLamports
    return mint === WSOL_MINT ? { maxLamportsOut: amount + rent } : { maxLamportsOut: rent, maxTokenOut: { mint, amount } }
  }

  /**
   * The wallet must receive at least `expected × (1 − slippage)` of `mint` (and at most `max`, when
   * given); rent is the only SOL it may lose.
   */
  protected receiveExpectation(mint: string, expected: bigint, extraLamports = 0n, max?: bigint): Expectation {
    if (expected <= 0n) throw new KaminoError(`Refusing a transaction that should pay out ${expected} of ${mint}: the amount must be positive.`)
    const min = (expected * BigInt(10_000 - this.slippageBps)) / 10_000n
    return { maxLamportsOut: this.rentAllowance + extraLamports, tokenIn: { mint, minAmount: min, ...(max !== undefined ? { maxAmount: max } : {}) } }
  }

  /** Simulate the built transaction through the account's guard and return its fee; nothing is signed. */
  protected async quoteBuilt(base64: string, expect: Expectation, instructions: readonly InstructionRule[]): Promise<{ fee: bigint }> {
    const s = this.surface()
    if (typeof s.checkSerialized !== 'function') throw new KaminoError('Quoting a Kamino transaction needs a @anywalletkit/wallet-solana account (checkSerialized).')
    const check = await s.checkSerialized(base64, this.guard(expect, instructions))
    return { fee: BigInt(check.quote.fee) }
  }

  /** Guard, sign and broadcast the built transaction; the account refuses before signing if the proof fails. */
  protected async sendBuilt(base64: string, expect: Expectation, instructions: readonly InstructionRule[], method: string): Promise<{ hash: string; fee: bigint }> {
    const account = this.requireSigningAccount(`${method}(options)`) as unknown as SolanaAccountSurface
    if (typeof account.sendSerialized !== 'function') throw new KaminoError(`${method}() needs a @anywalletkit/wallet-solana account (sendSerialized).`)
    const sent = await account.sendSerialized(base64, this.guard(expect, instructions))
    if (!sent?.hash) throw new KaminoError('The account returned no transaction signature.')
    return { hash: sent.hash, fee: BigInt(sent.fee ?? 0) }
  }

  protected memo(): string | undefined {
    return this._config.memo
  }
}
