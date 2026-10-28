// On-chain state the guard's bounds come from, so the Kamino API's figures are checked against the
// chain instead of trusted (scan 2026-10-27 modules, F2/F6/F10/F12): a kVault's share price from its
// own state and the reserves it invests in, the wallet's shares (wallet + farm stake), and the
// vanilla obligation's deposit and debt. Offsets follow the klend 1.25 / kvault 2.2 / farms IDLs
// (github.com/Kamino-Finance/klend-sdk) and were checked against mainnet accounts on 2026-10-28:
// the vault price computed here matched the API's `tokensPerShare` to within 3e-6.
import { base58 } from '@scure/base'
import { WAD } from './amounts.js'
import { KaminoError } from './errors.js'
import { FARMS_PROGRAM, KLEND_PROGRAM, KVAULT_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './programs.js'

/** An account as the wallet's RPC returns it. */
export interface ChainAccount { owner: string; lamports: bigint; data: Uint8Array }

/** klend / kvault fixed point (`Fraction`): 60 fractional bits. */
export const SF = 1n << 60n
/** Farm stake is kept as base units × 10^18. */
export const FARM_STAKE_SCALE = 10n ** 18n
/** How far the API's figures may sit from the chain's before the operation is refused, in basis points. */
export const CHAIN_TOLERANCE_BPS = 100n
const DEFAULT_KEY = '11111111111111111111111111111111'

/** Anchor account discriminators (sha256("account:<Name>")[0..8]) and the sizes the layouts below need. */
const KINDS = {
  VaultState: { program: KVAULT_PROGRAM, disc: 'e4c452a562d2eb98', size: 62_552 },
  Reserve: { program: KLEND_PROGRAM, disc: '2bf2ccca1af73b7f', size: 8_624 },
  Obligation: { program: KLEND_PROGRAM, disc: 'a8ce8d6a584caca7', size: 3_344 },
  UserState: { program: FARMS_PROGRAM, disc: '48b155f94ca7ba7e', size: 920 },
} as const

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true)
const u128 = (d: Uint8Array, o: number) => u64(d, o) + (u64(d, o + 8) << 64n)
const u256 = (d: Uint8Array, o: number) => u128(d, o) + (u128(d, o + 16) << 128n)
const key = (d: Uint8Array, o: number) => base58.encode(d.subarray(o, o + 32))
/** Mint decimals, stored as u64: a real mint has at most 255 (u8), so anything above is a broken account. */
function decimalsAt(d: Uint8Array, o: number, what: string): number {
  const v = u64(d, o)
  if (v > 255n) throw new KaminoError(`${what} records ${v} decimals; a mint has at most 255.`)
  return Number(v.toString()) // bounded to 255 above
}

function bytesOf(kind: keyof typeof KINDS, address: string, acc: ChainAccount | null): Uint8Array {
  const k = KINDS[kind]
  if (!acc) throw new KaminoError(`${kind} ${address} does not exist on chain.`)
  if (acc.owner !== k.program) throw new KaminoError(`${address} is not a Kamino ${kind}: it belongs to ${acc.owner}.`)
  if (acc.data.length < k.size || hex(acc.data.subarray(0, 8)) !== k.disc) throw new KaminoError(`${address} is not a Kamino ${kind} account.`)
  return acc.data
}

export interface VaultChain {
  tokenMint: string
  tokenDecimals: number
  tokenProgram: string
  sharesMint: string
  sharesDecimals: number
  tokenAvailable: bigint
  sharesIssued: bigint
  pendingFeesSf: bigint
  /** Reserves the vault has invested in and the collateral (cTokens) it holds in each. */
  allocations: Array<{ reserve: string; ctokens: bigint }>
  minDeposit: bigint
  minWithdraw: bigint
  farm: string | null
}

/** A kVault's `VaultState`. */
export function decodeVault(address: string, acc: ChainAccount | null): VaultChain {
  const d = bytesOf('VaultState', address, acc)
  const allocations: VaultChain['allocations'] = []
  for (let i = 0; i < 25; i++) {
    const o = 312 + i * 2160
    const reserve = key(d, o)
    if (reserve !== DEFAULT_KEY) allocations.push({ reserve, ctokens: u64(d, o + 1104) })
  }
  const farm = key(d, 58_600)
  return {
    tokenMint: key(d, 80), tokenDecimals: decimalsAt(d, 112, `Vault ${address}`), tokenProgram: key(d, 152),
    sharesMint: key(d, 184), sharesDecimals: decimalsAt(d, 216, `Vault ${address}`),
    tokenAvailable: u64(d, 224), sharesIssued: u64(d, 232), pendingFeesSf: u128(d, 296),
    allocations, minDeposit: u64(d, 58_408), minWithdraw: u64(d, 58_416), farm: farm === DEFAULT_KEY ? null : farm,
  }
}

export interface ReserveChain {
  lendingMarket: string
  mint: string
  decimals: number
  tokenProgram: string
  /** Liquidity the reserve owes its depositors (available + borrowed − fees), scaled by {@link SF}. */
  totalLiquiditySf: bigint
  /** cTokens issued against it. */
  collateralSupply: bigint
  /** Cumulative borrow rate (scaled by {@link SF}) at the reserve's last refresh. */
  cumulativeBorrowRate: bigint
}

/** A klend `Reserve`. */
export function decodeReserve(address: string, acc: ChainAccount | null): ReserveChain {
  const d = bytesOf('Reserve', address, acc)
  const total = u64(d, 224) * SF + u128(d, 232) - u128(d, 344) - u128(d, 360) - u128(d, 376)
  return {
    lendingMarket: key(d, 32), mint: key(d, 128), decimals: decimalsAt(d, 272, `Reserve ${address}`), tokenProgram: key(d, 408),
    totalLiquiditySf: total > 0n ? total : 0n, collateralSupply: u64(d, 2592), cumulativeBorrowRate: u256(d, 296),
  }
}

/** Liquidity (scaled by {@link SF}) that `ctokens` of the reserve redeem for, as klend's exchange rate counts it. */
export function collateralToLiquiditySf(r: ReserveChain, ctokens: bigint): bigint {
  if (r.collateralSupply === 0n || r.totalLiquiditySf === 0n) return ctokens * SF
  return (ctokens * r.totalLiquiditySf) / r.collateralSupply
}

export interface ObligationChain {
  lendingMarket: string
  owner: string
  deposits: Array<{ reserve: string; ctokens: bigint }>
  borrows: Array<{ reserve: string; borrowedSf: bigint; cumulativeBorrowRate: bigint }>
}

/** A klend `Obligation`. */
export function decodeObligation(address: string, acc: ChainAccount | null): ObligationChain {
  const d = bytesOf('Obligation', address, acc)
  const deposits: ObligationChain['deposits'] = [], borrows: ObligationChain['borrows'] = []
  for (let i = 0; i < 8; i++) {
    const o = 96 + i * 136
    const reserve = key(d, o)
    if (reserve !== DEFAULT_KEY) deposits.push({ reserve, ctokens: u64(d, o + 32) })
  }
  for (let i = 0; i < 5; i++) {
    const o = 1208 + i * 200
    const reserve = key(d, o)
    if (reserve !== DEFAULT_KEY) borrows.push({ reserve, cumulativeBorrowRate: u256(d, o + 32), borrowedSf: u128(d, o + 88) })
  }
  return { lendingMarket: key(d, 32), owner: key(d, 64), deposits, borrows }
}

/** What an obligation leg is worth in base units of the reserve's token: deposits rounded down, debt (with the interest the reserve has accrued since) up. */
export function depositedLiquidity(o: ObligationChain, r: ReserveChain, reserve: string): bigint {
  return o.deposits.filter((x) => x.reserve === reserve).reduce((sum, x) => sum + collateralToLiquiditySf(r, x.ctokens) / SF, 0n)
}

export function debtNow(o: ObligationChain, r: ReserveChain, reserve: string): bigint {
  return o.borrows.filter((x) => x.reserve === reserve).reduce((sum, x) => {
    const sf = x.cumulativeBorrowRate > 0n && r.cumulativeBorrowRate > x.cumulativeBorrowRate ? (x.borrowedSf * r.cumulativeBorrowRate) / x.cumulativeBorrowRate : x.borrowedSf
    return sum + (sf + SF - 1n) / SF
  }, 0n)
}

/** A farm `UserState`: whose it is, which farm, and the shares staked (base units). */
export function decodeFarmUser(address: string, acc: ChainAccount | null): { farm: string; owner: string; staked: bigint } {
  const d = bytesOf('UserState', address, acc)
  return { farm: key(d, 16), owner: key(d, 48), staked: u128(d, 408) / FARM_STAKE_SCALE }
}

/** The amount of an SPL / Token-2022 account of `mint` owned by `owner`; 0 for anything else (missing, another mint or owner). */
export function tokenAmount(acc: ChainAccount | null, mint: string, owner: string): bigint {
  if (!acc || (acc.owner !== TOKEN_PROGRAM && acc.owner !== TOKEN_2022_PROGRAM) || acc.data.length < 165) return 0n
  if (key(acc.data, 0) !== mint || key(acc.data, 32) !== owner) return 0n
  return u64(acc.data, 64)
}

/**
 * Assets per share in token units, as a WAD (what the API's `tokensPerShare` means): the vault's idle
 * tokens plus what its cTokens redeem for at each reserve's rate, less pending fees, over the shares
 * issued. An empty vault prices a share at one token.
 */
export function vaultTokensPerShareWad(v: VaultChain, reserves: ReadonlyMap<string, ReserveChain>): bigint {
  let aumSf = v.tokenAvailable * SF
  for (const a of v.allocations) {
    if (a.ctokens === 0n) continue
    const r = reserves.get(a.reserve)
    if (!r) throw new KaminoError(`The vault's reserve ${a.reserve} was not read.`)
    aumSf += collateralToLiquiditySf(r, a.ctokens)
  }
  aumSf -= v.pendingFeesSf
  if (v.sharesIssued === 0n) return WAD
  if (aumSf <= 0n) throw new KaminoError('The vault holds nothing against its shares on chain.')
  return (aumSf * 10n ** BigInt(v.sharesDecimals) * WAD) / (v.sharesIssued * SF * 10n ** BigInt(v.tokenDecimals))
}

/** `a` and `b` within {@link CHAIN_TOLERANCE_BPS} of each other (relative to `b`, the chain's figure). */
export function withinTolerance(a: bigint, b: bigint): boolean {
  const diff = a > b ? a - b : b - a
  return diff * 10_000n <= b * CHAIN_TOLERANCE_BPS
}
