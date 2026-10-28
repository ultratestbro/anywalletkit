// Chain state as the module reads it: VaultState, Reserve, Obligation, farm UserState and token
// accounts laid out byte for byte (offsets in src/chain.ts, checked against mainnet 2026-10-28), built
// from the figures a test names.
import { base58 } from '@scure/base'
import { WAD, toWad } from '../src/amounts.js'
import { SF, decodeReserve, decodeVault, vaultTokensPerShareWad, type ChainAccount } from '../src/chain.js'
import { associatedTokenAddress, farmUserState, vanillaObligation } from '../src/pda.js'
import { FARMS_PROGRAM, KLEND_PROGRAM, KVAULT_PROGRAM, TOKEN_PROGRAM } from '../src/programs.js'
import { FARM, MARKET, SHARES, SOL, SOL_RESERVE, USDC, USDC_RESERVE, USDC_RESERVE_SMALL, USER, VAULT, vaultMetrics, vaultRow } from './fixture.js'

const DISC = { VaultState: 'e4c452a562d2eb98', Reserve: '2bf2ccca1af73b7f', Obligation: 'a8ce8d6a584caca7', UserState: '48b155f94ca7ba7e' } as const
const SIZE = { VaultState: 62_552, Reserve: 8_624, Obligation: 3_344, UserState: 920 } as const

function blank(kind: keyof typeof DISC): Uint8Array {
  const d = new Uint8Array(SIZE[kind])
  d.set(Buffer.from(DISC[kind], 'hex'), 0)
  return d
}
const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength)
const putKey = (d: Uint8Array, o: number, a: string) => d.set(base58.decode(a), o)
const putU64 = (d: Uint8Array, o: number, v: bigint) => view(d).setBigUint64(o, v, true)
const putU128 = (d: Uint8Array, o: number, v: bigint) => { putU64(d, o, v & (2n ** 64n - 1n)); putU64(d, o + 8, v >> 64n) }
const putU256 = (d: Uint8Array, o: number, v: bigint) => { putU128(d, o, v & (2n ** 128n - 1n)); putU128(d, o + 16, v >> 128n) }
const DEFAULT_KEY = '11111111111111111111111111111111'

export interface VaultFigures {
  tokenMint?: string; sharesMint?: string; tokenDecimals?: number; sharesDecimals?: number; tokenProgram?: string
  tokenAvailable: bigint; sharesIssued: bigint; pendingFeesSf?: bigint
  allocations: Array<{ reserve: string; ctokens: bigint }>
  minDeposit?: bigint; minWithdraw?: bigint; farm?: string | null
}

export function vaultAccount(f: VaultFigures, owner = KVAULT_PROGRAM): ChainAccount {
  const d = blank('VaultState')
  putKey(d, 80, f.tokenMint ?? USDC); putU64(d, 112, BigInt(f.tokenDecimals ?? 6)); putKey(d, 152, f.tokenProgram ?? TOKEN_PROGRAM)
  putKey(d, 184, f.sharesMint ?? SHARES); putU64(d, 216, BigInt(f.sharesDecimals ?? 6))
  putU64(d, 224, f.tokenAvailable); putU64(d, 232, f.sharesIssued); putU128(d, 296, f.pendingFeesSf ?? 0n)
  for (let i = 0; i < 25; i++) putKey(d, 312 + i * 2160, DEFAULT_KEY)
  f.allocations.forEach((a, i) => { putKey(d, 312 + i * 2160, a.reserve); putU64(d, 312 + i * 2160 + 1104, a.ctokens) })
  putU64(d, 58_408, f.minDeposit ?? 1000n); putU64(d, 58_416, f.minWithdraw ?? 1000n)
  putKey(d, 58_600, f.farm === undefined ? FARM : f.farm ?? DEFAULT_KEY)
  return { owner, lamports: 1n, data: d }
}

export interface ReserveFigures {
  market?: string; mint: string; decimals?: number; tokenProgram?: string
  /** Liquidity available, borrowed (× SF) and the cTokens issued: the exchange rate is (available + borrowed) / cTokens. */
  available: bigint; borrowedSf?: bigint; collateralSupply: bigint
  cumulativeBorrowRate?: bigint
}

export function reserveAccount(f: ReserveFigures, owner = KLEND_PROGRAM): ChainAccount {
  const d = blank('Reserve')
  putKey(d, 32, f.market ?? MARKET); putKey(d, 128, f.mint); putU64(d, 224, f.available); putU128(d, 232, f.borrowedSf ?? 0n)
  putU64(d, 272, BigInt(f.decimals ?? 6)); putU256(d, 296, f.cumulativeBorrowRate ?? SF); putKey(d, 408, f.tokenProgram ?? TOKEN_PROGRAM)
  putU64(d, 2592, f.collateralSupply)
  return { owner, lamports: 1n, data: d }
}

export interface ObligationFigures {
  market?: string; owner?: string
  deposits?: Array<{ reserve: string; ctokens: bigint }>
  borrows?: Array<{ reserve: string; borrowedSf: bigint; cumulativeBorrowRate?: bigint }>
}

export function obligationAccount(f: ObligationFigures): ChainAccount {
  const d = blank('Obligation')
  putKey(d, 32, f.market ?? MARKET); putKey(d, 64, f.owner ?? USER)
  for (let i = 0; i < 8; i++) putKey(d, 96 + i * 136, DEFAULT_KEY)
  for (let i = 0; i < 5; i++) putKey(d, 1208 + i * 200, DEFAULT_KEY)
  ;(f.deposits ?? []).forEach((x, i) => { putKey(d, 96 + i * 136, x.reserve); putU64(d, 96 + i * 136 + 32, x.ctokens) })
  ;(f.borrows ?? []).forEach((x, i) => { const o = 1208 + i * 200; putKey(d, o, x.reserve); putU256(d, o + 32, x.cumulativeBorrowRate ?? SF); putU128(d, o + 88, x.borrowedSf) })
  return { owner: KLEND_PROGRAM, lamports: 1n, data: d }
}

export function farmUserAccount(f: { farm?: string; owner?: string; staked: bigint }): ChainAccount {
  const d = blank('UserState')
  putKey(d, 16, f.farm ?? FARM); putKey(d, 48, f.owner ?? USER); putU128(d, 408, f.staked * 10n ** 18n); putKey(d, 480, f.owner ?? USER)
  return { owner: FARMS_PROGRAM, lamports: 1n, data: d }
}

export function tokenAccount(mint: string, owner: string, amount: bigint, program = TOKEN_PROGRAM): ChainAccount {
  const d = new Uint8Array(165)
  putKey(d, 0, mint); putKey(d, 32, owner); putU64(d, 64, amount); d[108] = 1
  return { owner: program, lamports: 2_039_280n, data: d }
}

/** A reserve whose cToken redeems 1:1, big enough for any test. */
const flat = (mint: string, decimals = 6, extra: Partial<ReserveFigures> = {}) => reserveAccount({ mint, decimals, available: 10n ** 15n, collateralSupply: 10n ** 15n, ...extra })

/**
 * The recorded vault (fixture.ts) on chain: idle tokens and shares as the API reports them, and its
 * one invested reserve redeeming 1:1, sized so the chain prices a share at the API's tokensPerShare.
 */
export const VAULT_TOKEN_AVAILABLE = BigInt(vaultRow.state.tokenAvailable)
export const VAULT_SHARES_ISSUED = BigInt(vaultRow.state.sharesIssued)
export const VAULT_INVESTED = (VAULT_SHARES_ISSUED * toWad(vaultMetrics.tokensPerShare)) / WAD - VAULT_TOKEN_AVAILABLE
export function vaultFigures(over: Partial<VaultFigures> = {}): VaultFigures {
  return { tokenAvailable: VAULT_TOKEN_AVAILABLE, sharesIssued: VAULT_SHARES_ISSUED, allocations: [{ reserve: USDC_RESERVE, ctokens: VAULT_INVESTED }], ...over }
}

/** The chain the fake account reads by default: the vault and the market's three reserves; no obligation, no shares. */
export function defaultChain(): Map<string, ChainAccount> {
  return new Map<string, ChainAccount>([
    [VAULT, vaultAccount(vaultFigures())],
    [USDC_RESERVE, flat(USDC)],
    [USDC_RESERVE_SMALL, flat(USDC)],
    [SOL_RESERVE, flat(SOL, 9)],
  ])
}

export const SHARES_ATA = associatedTokenAddress(USER, SHARES, TOKEN_PROGRAM)
export const USER_STATE = farmUserState(FARM, USER)
export const OBLIGATION = vanillaObligation(USER, MARKET)

/** The share price the module computes from {@link defaultChain}: what its write bounds use. */
export const CHAIN_TPS = vaultTokensPerShareWad(decodeVault(VAULT, vaultAccount(vaultFigures())), new Map([[USDC_RESERVE, decodeReserve(USDC_RESERVE, flat(USDC))]]))
