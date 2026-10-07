/**
 * Guard for provider-built ("serialized") transactions — the base64 wire a
 * swap aggregator hands back for the wallet to sign as-is. The wallet cannot
 * rebuild such a transaction (the route lives inside the aggregator), so
 * instead of trusting it the guard proves what it does:
 *
 *   1. every program it invokes is on an allowlist;
 *   2. the usual compiled-tx checks (fee payer, co-signers, authority /
 *      delegate changes) pass;
 *   3. a simulation with post-state accounts shows the balance changes the
 *      caller declared — SOL out within a ceiling, the expected token in at
 *      least the quoted minimum, no other token account of ours drained.
 *
 * Only after all three does the account sign.
 */
import { getAddressEncoder, getBase64Encoder } from '@solana/kit'
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget'
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system'
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'
import { ZERO_ADDRESS } from './describe.js'
import type { SimulationResult, SolanaFeeQuote, TransactionDescription } from './types.js'

/** Memo program (v2) — swap aggregators tag routes with it. */
export const MEMO_PROGRAM_ADDRESS = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
/** Jupiter aggregator v6 — the router behind LI.FI's Solana legs. */
export const JUPITER_V6_PROGRAM_ADDRESS = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
/** Wrapped SOL mint; a "token in" of wSOL is measured on the SOL balance (aggregators unwrap it). */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112'

/** Programs a provider transaction may invoke unless the caller widens the list. */
export const DEFAULT_PROGRAM_ALLOWLIST: readonly string[] = Object.freeze([
  SYSTEM_PROGRAM_ADDRESS as string,
  TOKEN_PROGRAM_ADDRESS as string,
  TOKEN_2022_PROGRAM_ADDRESS as string,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS as string,
  COMPUTE_BUDGET_PROGRAM_ADDRESS as string,
  MEMO_PROGRAM_ADDRESS,
  JUPITER_V6_PROGRAM_ADDRESS,
])

/** What the caller expects the transaction to do with this wallet's balances. */
export interface SerializedExpectation {
  /** Most lamports the wallet may lose, fee excluded (the swap input for a SOL source; rent/fee slack for a token source). */
  maxLamportsOut: bigint
  /** Token the wallet must RECEIVE (same-chain swaps): the mint and the quoted minimum. Native SOL is `11111111111111111111111111111111`, `0x0…` or the wSOL mint. */
  tokenIn?: { mint: string; minAmount: bigint }
  /** Token the wallet may SEND and the most it may lose of it (the swap input for a token source). */
  maxTokenOut?: { mint: string; amount: bigint }
}

export interface SerializedTxGuard {
  /** Program ids the transaction may invoke. Default {@link DEFAULT_PROGRAM_ALLOWLIST}. */
  programAllowlist?: readonly string[]
  /** Skip the allowlist (NOT the balance checks). */
  allowUnknownPrograms?: boolean
  expect: SerializedExpectation
}

/** What the guard proved before signing. */
export interface SerializedCheck {
  description: TransactionDescription
  simulation: Extract<SimulationResult, { ok: true }>
  quote: SolanaFeeQuote
  /** post − pre lamports of the wallet (negative = spent), fee included. */
  lamportsDelta: bigint
  /** post − pre of the expected token across the wallet's ATAs (undefined without `tokenIn` or for native). */
  tokenInDelta: bigint | undefined
  /** post − pre of the token the wallet may send (undefined without `maxTokenOut`). */
  tokenOutDelta: bigint | undefined
  /** Accounts whose pre/post state was compared. */
  watched: readonly string[]
}

export const isNativeMint = (mint: string): boolean => mint === ZERO_ADDRESS || /^0x0+$/.test(mint) || mint === WSOL_MINT

/** The fixed prefix of an SPL / Token-2022 token account: mint, owner, amount (u64 LE at offset 64). */
export const TOKEN_ACCOUNT_MIN_SIZE = 165

export interface ParsedTokenAccount {
  mint: Uint8Array
  owner: Uint8Array
  amount: bigint
}

export function parseTokenAccount(data: Uint8Array): ParsedTokenAccount | null {
  if (data.length < TOKEN_ACCOUNT_MIN_SIZE) return null
  return {
    mint: data.subarray(0, 32),
    owner: data.subarray(32, 64),
    amount: new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true),
  }
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])
export const pubkeyBytes = (address: string): Uint8Array => getAddressEncoder().encode(address as never) as Uint8Array
export const base64Bytes = (data: string): Uint8Array => getBase64Encoder().encode(data) as Uint8Array
