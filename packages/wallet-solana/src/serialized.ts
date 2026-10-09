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
/**
 * "LI.FI Solana Program 1" (github.com/lifinance/solana-programs, listed in
 * Solana Explorer's verified programs). Its only instruction, `TrackV1`, logs
 * a LI.FI transaction id against two READ-ONLY accounts (the Clock sysvar and
 * an epoch PDA) — a memo in all but name. Every LI.FI cross-chain quote from
 * Solana (NEAR Intents legs, seen 2026-10-09) prepends it to the deposit.
 */
export const LIFI_TRACKING_PROGRAM_ADDRESS = '3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br'
/**
 * Relay Protocol's Solana depository ("Relay Bridge" in Jupiter's platform
 * list; github.com/reservoirprotocol). LI.FI's `relaydepository` tool — its
 * only route from Solana to HyperEVM (2026-10-09) — approves the depository
 * as delegate on the source token account and lets it pull the amount in the
 * same transaction; the guard verifies the delegate is spent (see
 * {@link ParsedTokenAccount.delegatedAmount}).
 */
export const RELAY_DEPOSITORY_PROGRAM_ADDRESS = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2'
/** Memo program v1 — LI.FI's Solana → Robinhood (relay) route tags with it (2026-10-09). */
export const MEMO_V1_PROGRAM_ADDRESS = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'
/**
 * Same-chain routers LI.FI's `jupiter` tool resolves to besides Jupiter v6
 * (names per MyTonWallet / OISY known-program lists, 2026-10-09).
 */
export const DFLOW_V4_PROGRAM_ADDRESS = 'DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH'
export const OKX_DEX_ROUTER_PROGRAM_ADDRESS = 'proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u'
/**
 * Mayan (LI.FI's `mayan` / `mayanMCTP` / `mayanFastMCTP` tools) — program ids
 * from github.com/mayan-finance/swap-sdk `src/addresses.ts` (2026-10-09),
 * plus the Wormhole core and Circle CCTP programs its routes CPI into. The
 * owner approved widening the list on 2026-10-10; the balance proof below
 * (SOL ceiling, token-in floor, no drain, no lingering delegate) stays the
 * guard that actually bounds what a route may do.
 */
export const MAYAN_PROGRAM_ADDRESSES: readonly string[] = Object.freeze([
  'FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf', // MAYAN_PROGRAM_ID
  'BLZRi6frs4X4DNLw56V4EXai1b6QVESN1BhHBTYM9VcY', // SWIFT_PROGRAM_ID
  'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny', // SWIFT_V2_PROGRAM_ID
  'dkpZqrxHFrhziEMQ931GLtfy11nFkCsfMftH9u6QwBU', // MCTP_PROGRAM_ID
  'Gx9rivpS3YR8pBFwMuP6omYqVxunpLvLkNn7ubNyuZZ5', // FAST_MCTP_PROGRAM_ID
  '8QJmxZcEzwuYmCPy6XqgN2sHcYCcFq6AEfBMJZZuLo5a', // AUCTION_PROGRAM_ID
  '5VtQHnhs2pfVEr68qQsbTRwKh4JV5GTu9mBHgHFxpHeQ', // FEE_MANAGER_PROGRAM_ID
  'B96dV3Luxzo6SokJx3xt8i5y8Mb7HRR6Eec8hCjJDT69', // SPL_UTILS_PROGRAM_ID
  'GFRP4yXUjvcQemf2zRJN8w9sPNaDk5PyBUQdPHD1AzLp', // MPS_PROGRAM_ID
  'D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa', // Mayan (swap-sdk addresses.ts; LI.FI `mayan` tool, seen live)
  'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth', // WORMHOLE_PROGRAM_ID
  'EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX', // WORMHOLE_SHIM_POST_MESSAGE_PROGRAM_ID
  'CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd', // CCTP_CORE_PROGRAM_ID
  'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC', // CCTPV2_CORE_PROGRAM_ID
  'CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3', // CCTP_TOKEN_PROGRAM_ID
  'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe', // CCTPV2_TOKEN_PROGRAM_ID
])
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
  LIFI_TRACKING_PROGRAM_ADDRESS,
  RELAY_DEPOSITORY_PROGRAM_ADDRESS,
  MEMO_V1_PROGRAM_ADDRESS,
  DFLOW_V4_PROGRAM_ADDRESS,
  OKX_DEX_ROUTER_PROGRAM_ADDRESS,
  ...MAYAN_PROGRAM_ADDRESSES,
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
  /** COption<Pubkey> at offset 72: the account's current delegate, if any. */
  delegate: Uint8Array | null
  /** u64 at offset 121: what that delegate may still pull. */
  delegatedAmount: bigint
}

export function parseTokenAccount(data: Uint8Array): ParsedTokenAccount | null {
  if (data.length < TOKEN_ACCOUNT_MIN_SIZE) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const hasDelegate = view.getUint32(72, true) === 1
  return {
    mint: data.subarray(0, 32),
    owner: data.subarray(32, 64),
    amount: view.getBigUint64(64, true),
    delegate: hasDelegate ? data.subarray(76, 108) : null,
    delegatedAmount: view.getBigUint64(121, true),
  }
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])
export const pubkeyBytes = (address: string): Uint8Array => getAddressEncoder().encode(address as never) as Uint8Array
export const base64Bytes = (data: string): Uint8Array => getBase64Encoder().encode(data) as Uint8Array
