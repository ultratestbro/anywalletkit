// Kamino's public REST API (api.kamino.finance, no key): discovery and
// decoration (markets, reserves, vaults, APY, positions) and the transaction
// builder (/ktx/…). A built transaction is never trusted as-is — the wallet's
// serialized-transaction guard proves its programs and balance effects before
// signing (see base.ts). Shapes as of 2026-10-13.
import { KaminoError } from './errors.js'
import { fromDecimalString } from './amounts.js'

export const KAMINO_API = 'https://api.kamino.finance'
/** Kamino's Main Market. */
export const MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'
/** The decimal string that means "every share" on /ktx/kvault/withdraw. */
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

export interface ApiLoanLeg { mint: string; symbol: string; amount: string; valueUsd: string }
export interface ApiObligation {
  obligation: string
  market: string
  user: string
  elevationGroup: number
  deposits: ApiLoanLeg[]
  borrows: ApiLoanLeg[]
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

export class KaminoApi {
  /** `timeoutMs` bounds each call (default 15 s): a silent API must not hang a read or a write's build. */
  constructor(private readonly endpoint: string = KAMINO_API, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15_000) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const signal = AbortSignal.timeout(this.timeoutMs)
    const timedOut = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new KaminoError(`Kamino API ${path} did not answer within ${this.timeoutMs} ms.`)), { once: true }))
    timedOut.catch(() => undefined)
    const call = async () => {
      const res = await this.fetchImpl(`${this.endpoint}${path}`, body === undefined
        ? { headers: { accept: 'application/json' }, signal }
        : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal })
      return { res, text: await res.text() }
    }
    // Raced as well: a fetch implementation that ignores the signal still gives way.
    const { res, text } = await Promise.race([call(), timedOut]).catch((e: unknown) => { throw signal.aborted ? new KaminoError(`Kamino API ${path} did not answer within ${this.timeoutMs} ms.`) : e })
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
      obligation: String(row.loanId ?? row.obligation ?? row.address ?? ''), market: String(row.marketId ?? market), user: String(row.user ?? ''),
      elevationGroup: num(row.elevationGroup), deposits: legs(coll.deposits ?? row.deposits), borrows: legs(debt.borrows ?? row.borrows),
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
  /** Base64 unsigned v0 transaction: redeem `amount` SHARES (decimal) — {@link WITHDRAW_ALL} for every share. */
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
