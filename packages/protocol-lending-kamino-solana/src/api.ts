// Kamino's public REST API (api.kamino.finance, no key): discovery and
// decoration (markets, reserves, vaults, APY, positions) and the transaction
// builder (/ktx/…). A built transaction is never trusted as-is — the wallet's
// serialized-transaction guard proves its programs and balance effects before
// signing (see base.ts). Shapes as of 2026-10-13.
import { KaminoError } from './errors.js'
import { fromDecimalString } from './amounts.js'
import type { ObligationLegs } from './chain.js'

export const KAMINO_API = 'https://api.kamino.finance'
/** Kamino's Main Market. */
export const MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'
/**
 * u64::MAX as a decimal share count. @deprecated The API scales `amount` by the shares' decimals and
 * now refuses this as above u64 (2026-10-28, `DECIMAL_TO_LAMPORTS_OVERFLOW`); `withdraw({ amount: 'max' })`
 * passes the wallet's exact share count, read from the chain, instead.
 */
export const WITHDRAW_ALL = '18446744073709551615'

export interface ApiMarket {
  lendingMarket: string
  name: string
  description: string
  isPrimary: boolean
  isCurated: boolean
  lookupTable: string | null
}

export interface ApiReserve {
  reserve: string
  symbol: string
  mint: string
  /** Fraction (0.74). */
  maxLtv: number
  /** Percent. */
  supplyApy: number
  borrowApy: number
  /** Decimal strings in token units. */
  totalSupply: string
  totalBorrow: string
  totalSupplyUsd: number
  totalBorrowUsd: number
}

export interface ApiVaultAllocation { reserve: string; targetAllocationWeight: number; tokenAllocationCap: bigint }

export interface ApiVault {
  address: string
  programId: string
  name: string
  tokenMint: string
  tokenMintDecimals: number
  tokenProgram: string
  sharesMint: string
  sharesMintDecimals: number
  /** Base units. */
  tokenAvailable: bigint
  sharesIssued: bigint
  minDepositAmount: bigint
  minWithdrawAmount: bigint
  performanceFeeBps: number
  managementFeeBps: number
  vaultFarm: string | null
  vaultLookupTable: string | null
  allocations: ApiVaultAllocation[]
}

export interface ApiVaultMetrics {
  /** Percent, net of fees. */
  apy: number
  apy24h: number
  apy7d: number
  apy30d: number
  apyActual: number
  apyFarmRewards: number
  /** Decimal strings. */
  tokenPrice: string
  sharePrice: string
  tokensPerShare: string
  tokensAvailable: string
  tokensInvested: string
  tokensInvestedUsd: string
  sharesIssued: string
  numberOfHolders: number
}

export interface ApiVaultPosition { vaultAddress: string; stakedShares: string; unstakedShares: string; totalShares: string }

export interface ApiLoanLeg {
  mint: string
  symbol: string
  /** Decimal string in token units. */
  amount: string
  /** Decimal string; '' when nothing reports one. */
  valueUsd: string
  /** The reserve the leg sits in, when known (always on legs read from the chain). */
  reserve?: string
}

/** An obligation's legs as the account stores them: cTokens per deposit reserve, debt × 2^60 with the borrow rate it was last charged at. */
export interface ApiObligationState extends ObligationLegs {
  owner: string
  lendingMarket: string
}

export interface ApiObligation {
  obligation: string
  market: string
  user: string
  elevationGroup: number
  /**
   * Per-token legs. From `getUserObligations` they are the API's decorated legs, which the live API
   * leaves empty (`{}`) since 2026-10-28; from `KaminoMarketProtocolSolana.getPosition` they are the
   * obligation's legs read from the chain.
   */
  deposits: ApiLoanLeg[]
  borrows: ApiLoanLeg[]
  /** The row's raw `state` decoded (where the live API keeps the legs now); null when it has none. */
  state: ApiObligationState | null
  /** Fractions. */
  currentLtv: number
  maxLtv: number | null
  liquidationLtv: number
  raw: unknown
}

export interface KtxVaultDeposit { wallet: string; kvault: string; amount: string; skipFarm?: boolean | undefined; memo?: string | undefined }
export interface KtxVaultWithdraw { wallet: string; kvault: string; amount: string; closeUserState?: boolean | undefined; memo?: string | undefined }
export interface KtxLend { wallet: string; market: string; reserve: string; amount: string; memo?: string | undefined }

const pct = (x: unknown): number => (x === null || x === undefined ? 0 : Number(x) * 100)
const num = (x: unknown, d = 0): number => (x === null || x === undefined || x === '' ? d : Number(x))
const big = (x: unknown): bigint => (x === null || x === undefined ? 0n : BigInt(String(x).split('.')[0]!))
const str = (x: unknown): string => (x === null || x === undefined ? '0' : String(x))
const DEFAULT_KEY = '11111111111111111111111111111111'

/** An unsigned integer of `bits` the API serializes (a decimal string, or a safe JSON number); anything else is refused. */
function uint(x: unknown, what: string, bits: 64 | 128): bigint {
  let v: bigint | undefined
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) v = BigInt(x)
  else if (typeof x === 'string' && x.length <= 40 && /^\d+$/.test(x)) v = BigInt(x)
  if (v === undefined || v >= 1n << BigInt(bits)) throw new KaminoError(`Kamino reported ${what} as ${String(x).slice(0, 40)}; it is a u${bits}.`)
  return v
}

/** klend's `BigFractionBytes` ({ value: four little-endian u64 limbs }) as one u256. */
function u256Limbs(x: unknown, what: string): bigint {
  const limbs = (x as { value?: unknown } | null)?.value
  if (!Array.isArray(limbs) || limbs.length !== 4) throw new KaminoError(`Kamino reported ${what} without its four limbs.`)
  return limbs.reduce<bigint>((sum, l, i) => sum + (uint(l, `a limb of ${what}`, 64) << BigInt(64 * i)), 0n)
}

/** The obligation account's legs as the API serializes its raw `state` (klend's `Obligation`, empty slots on the default key). */
function obligationState(x: unknown): ApiObligationState | null {
  if (!x || typeof x !== 'object') return null
  const s = x as Record<string, unknown>
  if (!Array.isArray(s.deposits) && !Array.isArray(s.borrows)) return null
  const slots = (v: unknown, key: string) => (Array.isArray(v) ? v : []).filter((l): l is Record<string, unknown> => !!l && typeof l === 'object' && String((l as Record<string, unknown>)[key] ?? DEFAULT_KEY) !== DEFAULT_KEY)
  return {
    owner: String(s.owner ?? ''), lendingMarket: String(s.lendingMarket ?? ''),
    deposits: slots(s.deposits, 'depositReserve').map((l) => ({ reserve: String(l.depositReserve), ctokens: uint(l.depositedAmount, 'a deposit\'s depositedAmount', 64) })),
    borrows: slots(s.borrows, 'borrowReserve').map((l) => ({
      reserve: String(l.borrowReserve), borrowedSf: uint(l.borrowedAmountSf, 'a borrow\'s borrowedAmountSf', 128), cumulativeBorrowRate: u256Limbs(l.cumulativeBorrowRateBsf, 'a borrow\'s cumulativeBorrowRateBsf'),
    })),
  }
}

export class KaminoApi {
  /** `timeoutMs` bounds each call (default 15 s): a silent API must not hang a read or a write's build. */
  constructor(private readonly endpoint: string = KAMINO_API, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15_000) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    // A plain timer, not AbortSignal.timeout: Node does not keep the process alive for the latter,
    // so a silent API would leave the call pending instead of timing it out.
    const controller = new AbortController()
    const signal = controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new KaminoError(`Kamino API ${path} did not answer within ${this.timeoutMs} ms.`)) }, this.timeoutMs)
    })
    const call = async () => {
      const res = await this.fetchImpl(`${this.endpoint}${path}`, body === undefined
        ? { headers: { accept: 'application/json' }, signal }
        : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal })
      return { res, text: await res.text() }
    }
    // Raced as well: a fetch implementation that ignores the signal still gives way.
    const { res, text } = await Promise.race([call(), timedOut])
      .catch((e: unknown) => { throw signal.aborted ? new KaminoError(`Kamino API ${path} did not answer within ${this.timeoutMs} ms.`) : e })
      .finally(() => clearTimeout(timer))
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
    if (!res.ok) {
      const e = (json ?? {}) as { message?: string; error?: string; code?: string; metadata?: string }
      throw new KaminoError(`Kamino API ${res.status} ${path}: ${e.message ?? e.error ?? e.metadata ?? text.slice(0, 200)}`, e.code)
    }
    return json as T
  }

  /** Every Kamino Lend market (Main Market first). */
  async listMarkets(): Promise<ApiMarket[]> {
    const rows = await this.request<Array<Record<string, unknown>>>('/v2/kamino-market')
    return rows.map((r) => ({
      lendingMarket: String(r.lendingMarket), name: String(r.name ?? ''), description: String(r.description ?? ''),
      isPrimary: !!r.isPrimary, isCurated: !!r.isCurated, lookupTable: r.lookupTable ? String(r.lookupTable) : null,
    })).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
  }

  /** A market's reserves with live rates. */
  async getReserves(market: string): Promise<ApiReserve[]> {
    const rows = await this.request<Array<Record<string, unknown>>>(`/kamino-market/${market}/reserves/metrics`)
    return rows.map((r) => ({
      reserve: String(r.reserve), symbol: String(r.liquidityToken ?? ''), mint: String(r.liquidityTokenMint),
      maxLtv: num(r.maxLtv), supplyApy: pct(r.supplyApy), borrowApy: pct(r.borrowApy),
      totalSupply: str(r.totalSupply), totalBorrow: str(r.totalBorrow), totalSupplyUsd: num(r.totalSupplyUsd), totalBorrowUsd: num(r.totalBorrowUsd),
    }))
  }

  private vault(row: Record<string, unknown>): ApiVault {
    const s = (row.state ?? {}) as Record<string, unknown>
    const alloc = (Array.isArray(s.vaultAllocationStrategy) ? s.vaultAllocationStrategy : []) as Array<Record<string, unknown>>
    return {
      address: String(row.address), programId: String(row.programId ?? ''), name: String(s.name ?? ''),
      tokenMint: String(s.tokenMint), tokenMintDecimals: num(s.tokenMintDecimals), tokenProgram: String(s.tokenProgram ?? ''),
      sharesMint: String(s.sharesMint), sharesMintDecimals: num(s.sharesMintDecimals),
      tokenAvailable: big(s.tokenAvailable), sharesIssued: big(s.sharesIssued),
      minDepositAmount: big(s.minDepositAmount), minWithdrawAmount: big(s.minWithdrawAmount),
      performanceFeeBps: num(s.performanceFeeBps), managementFeeBps: num(s.managementFeeBps),
      vaultFarm: s.vaultFarm && String(s.vaultFarm) !== '11111111111111111111111111111111' ? String(s.vaultFarm) : null,
      vaultLookupTable: s.vaultLookupTable ? String(s.vaultLookupTable) : null,
      allocations: alloc.filter((a) => num(a.targetAllocationWeight) > 0 || big(a.ctokenAllocation) > 1n)
        .map((a) => ({ reserve: String(a.reserve), targetAllocationWeight: num(a.targetAllocationWeight), tokenAllocationCap: big(a.tokenAllocationCap) })),
    }
  }

  /** Every Earn vault (kVault) on the mainnet program. */
  async listVaults(): Promise<ApiVault[]> {
    const rows = await this.request<Array<Record<string, unknown>>>('/kvaults/vaults')
    return rows.map((r) => this.vault(r))
  }

  async getVault(vault: string): Promise<ApiVault> {
    return this.vault(await this.request<Record<string, unknown>>(`/kvaults/vaults/${vault}`))
  }

  async getVaultMetrics(vault: string): Promise<ApiVaultMetrics> {
    const m = await this.request<Record<string, unknown>>(`/kvaults/vaults/${vault}/metrics`)
    return {
      apy: pct(m.apy), apy24h: pct(m.apy24h), apy7d: pct(m.apy7d), apy30d: pct(m.apy30d), apyActual: pct(m.apyActual), apyFarmRewards: pct(m.apyFarmRewards),
      tokenPrice: str(m.tokenPrice), sharePrice: str(m.sharePrice), tokensPerShare: str(m.tokensPerShare),
      tokensAvailable: str(m.tokensAvailable), tokensInvested: str(m.tokensInvested), tokensInvestedUsd: str(m.tokensInvestedUsd),
      sharesIssued: str(m.sharesIssued), numberOfHolders: num(m.numberOfHolders),
    }
  }

  /** The user's shares in one vault; a user the vault has never seen is a zero position. */
  async getVaultPosition(user: string, vault: string): Promise<ApiVaultPosition> {
    try {
      const p = await this.request<Record<string, unknown>>(`/kvaults/users/${user}/positions/${vault}`)
      return { vaultAddress: String(p.vaultAddress ?? vault), stakedShares: str(p.stakedShares), unstakedShares: str(p.unstakedShares), totalShares: str(p.totalShares) }
    } catch (e) {
      if (e instanceof KaminoError && /\b404\b/.test(e.message)) return { vaultAddress: vault, stakedShares: '0', unstakedShares: '0', totalShares: '0' }
      throw e
    }
  }

  async listVaultPositions(user: string): Promise<ApiVaultPosition[]> {
    const rows = await this.request<Array<Record<string, unknown>>>(`/kvaults/users/${user}/positions`)
    return rows.map((p) => ({ vaultAddress: String(p.vaultAddress), stakedShares: str(p.stakedShares), unstakedShares: str(p.unstakedShares), totalShares: str(p.totalShares) }))
  }

  private obligation(row: Record<string, unknown>, market: string): ApiObligation {
    const info = (row.loanInfo ?? row) as Record<string, unknown>
    const legs = (x: unknown): ApiLoanLeg[] => (Array.isArray(x) ? x : []).map((l: Record<string, unknown>) => ({
      mint: String(l.tokenMint ?? l.mint ?? ''), symbol: String(l.tokenName ?? l.symbol ?? ''), amount: str(l.tokenAmount ?? l.amount), valueUsd: str(l.tokenValue ?? l.valueUsd),
    }))
    const coll = (info.collateral ?? {}) as Record<string, unknown>, debt = (info.debt ?? {}) as Record<string, unknown>
    return {
      obligation: String(row.obligationAddress ?? row.loanId ?? row.obligation ?? row.address ?? ''), market: String(row.marketId ?? market), user: String(row.user ?? ''),
      elevationGroup: num(row.elevationGroup), deposits: legs(coll.deposits ?? row.deposits), borrows: legs(debt.borrows ?? row.borrows), state: obligationState(row.state),
      currentLtv: num(info.currentLtv), maxLtv: info.maxLtv === null || info.maxLtv === undefined ? null : num(info.maxLtv), liquidationLtv: num(info.liquidationLtv),
      raw: row,
    }
  }

  /** The user's obligations (loans) in a market. */
  async getUserObligations(market: string, user: string): Promise<ApiObligation[]> {
    const rows = await this.request<unknown>(`/kamino-market/${market}/users/${user}/obligations`)
    const list = Array.isArray(rows) ? rows : rows && typeof rows === 'object' && Array.isArray((rows as { obligations?: unknown }).obligations) ? (rows as { obligations: unknown[] }).obligations : []
    return (list as Array<Record<string, unknown>>).map((r) => this.obligation(r, market))
  }

  // ---- transaction builder --------------------------------------------------

  private async ktx(path: string, body: unknown): Promise<string> {
    const r = await this.request<{ transaction?: string }>(path, body)
    if (!r?.transaction) throw new KaminoError(`Kamino API ${path} returned no transaction.`)
    return r.transaction
  }

  /** Base64 unsigned v0 transaction: deposit `amount` (decimal, token units) into an Earn vault. */
  buildVaultDeposit(p: KtxVaultDeposit): Promise<string> { return this.ktx('/ktx/kvault/deposit', strip(p)) }
  /** Base64 unsigned v0 transaction: redeem `amount` SHARES (decimal). */
  buildVaultWithdraw(p: KtxVaultWithdraw): Promise<string> { return this.ktx('/ktx/kvault/withdraw', strip(p)) }
  buildLendDeposit(p: KtxLend): Promise<string> { return this.ktx('/ktx/klend/deposit', strip(p)) }
  buildLendWithdraw(p: KtxLend): Promise<string> { return this.ktx('/ktx/klend/withdraw', strip(p)) }
  buildLendBorrow(p: KtxLend): Promise<string> { return this.ktx('/ktx/klend/borrow', strip(p)) }
  buildLendRepay(p: KtxLend): Promise<string> { return this.ktx('/ktx/klend/repay', strip(p)) }
}

/** Drop undefined fields (the API rejects explicit nulls). */
function strip<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

export { fromDecimalString }
