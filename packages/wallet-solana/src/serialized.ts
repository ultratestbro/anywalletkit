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
import { UnsafeTransactionError } from './errors.js'
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
/** OKX DEX router, reached through LI.FI's Solana `jupiter` tool. */
export const OKX_DEX_ROUTER_PROGRAM_ADDRESS = 'proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u'
/** Titan Exchange aggregator — LI.FI's jupiter tool routed Solana USDe → USDC through it (2026-10-10). */
export const TITAN_PROGRAM_ADDRESS = 'T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT'
/** Relay Forwarder (relayprotocol/relay-settlement, solana-vm/programs/relay-forwarder) — LI.FI relay routes out of Solana (2026-10-10). */
export const RELAY_FORWARDER_PROGRAM_ADDRESS = 'DPArtTLbEqa6EuXHfL5UFLBZhFjiEXWRudhvXDrjwXUr'
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
  TITAN_PROGRAM_ADDRESS,
  RELAY_FORWARDER_PROGRAM_ADDRESS,
  ...MAYAN_PROGRAM_ADDRESSES,
])

/**
 * What the caller expects the transaction to do with this wallet's balances. Every bound is a
 * non-negative bigint; anything else is refused before the network is consulted (a negative
 * minimum would read as permission to lose that much — scan 2026-10-27 modules, F10/F11).
 */
export interface SerializedExpectation {
  /** Most lamports the wallet may lose, fee excluded (the swap input for a SOL source; rent/fee slack for a token source). */
  maxLamportsOut: bigint
  /**
   * Token the wallet must RECEIVE (same-chain swaps): the mint and the quoted minimum. Native SOL is
   * `11111111111111111111111111111111`, `0x0…` or the wSOL mint. `maxAmount`, when set, is the most
   * it may receive: a builder that hands over more than was asked did something else (a bigger borrow).
   */
  tokenIn?: { mint: string; minAmount: bigint; maxAmount?: bigint }
  /** Token the wallet may SEND and the most it may lose of it (the swap input for a token source). */
  maxTokenOut?: { mint: string; amount: bigint }
}

/**
 * One instruction shape a provider transaction may carry (see {@link SerializedTxGuard.instructions}):
 * the program, the first bytes of its data (an Anchor discriminator, an SPL tag), and the accounts it
 * must pass at given positions.
 */
export interface SerializedInstructionRule {
  /** Program the instruction calls. */
  program: string
  /** Hex the instruction data starts with (case-insensitive); omitted = any data. */
  data?: string
  /** Exact length of the instruction data in bytes, for fixed layouts. */
  dataLength?: number
  /** Accounts by position in the instruction: this address, or one of these. Lookup-table accounts are resolved first. */
  accounts?: Readonly<Record<number, string | readonly string[]>>
}

export interface SerializedTxGuard {
  /** Program ids the transaction may invoke. Default {@link DEFAULT_PROGRAM_ALLOWLIST}. */
  programAllowlist?: readonly string[]
  /** Skip the allowlist (NOT the balance checks). */
  allowUnknownPrograms?: boolean
  /**
   * Every top-level instruction must match one of these rules, or the transaction is refused
   * (`unexpected-instruction`). For callers that know the exact instructions an operation takes —
   * a lending deposit, say — where an extra withdrawal plus a transfer signed by the same key would
   * otherwise pass as long as the net balances hold (scan 2026-10-27 modules, F1).
   */
  instructions?: readonly SerializedInstructionRule[]
  /** What the transaction may do to the wallet's balances. */
  expect: SerializedExpectation
}

/** An account as `getMultipleAccounts` returns it: owner program, lamports and raw data. */
export interface SolanaAccountData {
  owner: string
  lamports: bigint
  data: Uint8Array
}

/** Refuse an expectation with a bound that is not a non-negative bigint. */
export function assertExpectation(expect: SerializedExpectation): void {
  const bad = (what: string, v: unknown) => {
    if (typeof v !== 'bigint' || v < 0n) throw new UnsafeTransactionError(`The guard's ${what} must be a non-negative bigint, got ${typeof v === 'bigint' ? v : typeof v}.`, 'invalid-expectation', [what])
  }
  if (!expect || typeof expect !== 'object') throw new UnsafeTransactionError('The guard has no expectation.', 'invalid-expectation')
  bad('maxLamportsOut', expect.maxLamportsOut)
  if (expect.tokenIn !== undefined) {
    bad('tokenIn.minAmount', expect.tokenIn.minAmount)
    if (expect.tokenIn.maxAmount !== undefined) {
      bad('tokenIn.maxAmount', expect.tokenIn.maxAmount)
      if (expect.tokenIn.maxAmount < expect.tokenIn.minAmount) throw new UnsafeTransactionError("The guard's tokenIn.maxAmount is below its minAmount.", 'invalid-expectation', ['tokenIn.maxAmount'])
    }
  }
  if (expect.maxTokenOut !== undefined) bad('maxTokenOut.amount', expect.maxTokenOut.amount)
}

const hexOf = (data: Uint8Array): string => Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('')

/** Check rules up front: a malformed one is the caller's mistake, never a silent "matches anything". */
function normalizeRules(rules: readonly SerializedInstructionRule[]): Array<{ program: string; data: string; dataLength: number | undefined; accounts: Array<[number, readonly string[]]> }> {
  if (!Array.isArray(rules) || rules.length === 0) throw new TypeError('guard.instructions must be a non-empty list of rules.')
  return rules.map((r) => {
    if (!r || typeof r.program !== 'string' || !r.program) throw new TypeError('Every instruction rule names its program.')
    const data = (r.data ?? '').toLowerCase()
    if (!/^(?:[0-9a-f]{2})*$/.test(data)) throw new TypeError(`Instruction rule data '${r.data}' is not hex.`)
    if (r.dataLength !== undefined && (!Number.isInteger(r.dataLength) || r.dataLength < data.length / 2)) throw new TypeError(`Instruction rule dataLength ${r.dataLength} is not a byte count of at least the data prefix.`)
    const accounts = Object.entries(r.accounts ?? {}).map(([k, v]): [number, readonly string[]] => {
      const at = Number(k)
      if (!Number.isInteger(at) || at < 0) throw new TypeError(`Instruction rule account position '${k}' is not an index.`)
      const list = typeof v === 'string' ? [v] : v
      if (!Array.isArray(list) || list.length === 0 || list.some((a) => typeof a !== 'string' || !a)) throw new TypeError(`Instruction rule account ${k} names no address.`)
      return [at, list]
    })
    return { program: r.program, data, dataLength: r.dataLength, accounts }
  })
}

/**
 * The first top-level instruction no rule allows, or undefined when every one matches. Instructions
 * are read from the compiled message with lookup-table accounts resolved (`resolveCompiledAccounts`).
 */
export function unexpectedInstruction(
  compiled: { instructions: ReadonlyArray<{ programAddressIndex: number; accountIndices?: readonly number[]; data?: ArrayLike<number> }> },
  accounts: ReadonlyArray<{ address: string | null }>,
  rules: readonly SerializedInstructionRule[],
): { index: number; program: string; data: string } | undefined {
  const allowed = normalizeRules(rules)
  for (let i = 0; i < compiled.instructions.length; i++) {
    const ix = compiled.instructions[i]!
    const program = accounts[ix.programAddressIndex]?.address ?? '<unresolved>'
    const bytes = ix.data ? Uint8Array.from(ix.data) : new Uint8Array()
    const hex = hexOf(bytes)
    const passed = (ix.accountIndices ?? []).map((j) => accounts[j]?.address ?? null)
    const ok = allowed.some((r) => r.program === program
      && hex.startsWith(r.data)
      && (r.dataLength === undefined || bytes.length === r.dataLength)
      && r.accounts.every(([at, want]) => { const got = passed[at]; return got !== null && got !== undefined && want.includes(got) }))
    if (!ok) return { index: i, program, data: hex.slice(0, 16) }
  }
  return undefined
}

/** What the guard proved before signing. */
export interface SerializedCheck {
  description: TransactionDescription
  simulation: Extract<SimulationResult, { ok: true }>
  quote: SolanaFeeQuote
  /** post − pre native SOL of the wallet (negative = spent), fee included: its lamports plus the wrapped SOL in token accounts it owns. */
  lamportsDelta: bigint
  /** post − pre of the expected token across the wallet's ATAs (undefined without `tokenIn` or for native). */
  tokenInDelta: bigint | undefined
  /** post − pre of the token the wallet may send (undefined without `maxTokenOut`). */
  tokenOutDelta: bigint | undefined
  /** Accounts whose pre/post state was compared. */
  watched: readonly string[]
}

/** True for every spelling of native SOL: the System program id, `0x0…`, or the wSOL mint. */
export const isNativeMint = (mint: string): boolean => mint === ZERO_ADDRESS || /^0x0+$/.test(mint) || mint === WSOL_MINT

/** The fixed prefix of an SPL / Token-2022 token account: mint, owner, amount (u64 LE at offset 64). */
export const TOKEN_ACCOUNT_MIN_SIZE = 165

/** The fixed fields of an SPL / Token-2022 token account. */
export interface ParsedTokenAccount {
  mint: Uint8Array
  owner: Uint8Array
  amount: bigint
  /** COption<Pubkey> at offset 72: the account's current delegate, if any. */
  delegate: Uint8Array | null
  /** u64 at offset 121: what that delegate may still pull. */
  delegatedAmount: bigint
  /** COption<Pubkey> at offset 129: who may close the account, if not the owner. */
  closeAuthority: Uint8Array | null
}

/**
 * Core-program instructions a provider route may carry beyond the ones the
 * guard decodes (transfers, ATA creation, approve, close): wSOL plumbing and
 * harmless queries. Everything else from System / Token / Token-2022 — Assign,
 * Allocate, nonce authority, Batch, Burn, UnwrapLamports, an undecodable
 * discriminator — is refused: none belongs in a swap and several hand the
 * wallet or a token account to someone else.
 */
export const SAFE_CORE_INSTRUCTIONS: Readonly<Record<string, ReadonlySet<string>>> = (() => {
  const token = new Set(['SyncNative', 'InitializeAccount', 'InitializeAccount2', 'InitializeAccount3', 'InitializeImmutableOwner', 'Revoke', 'GetAccountDataSize', 'AmountToUiAmount', 'UiAmountToAmount'])
  return Object.freeze({
    [SYSTEM_PROGRAM_ADDRESS as string]: new Set(['CreateAccountWithSeed', 'TransferSolWithSeed']),
    [TOKEN_PROGRAM_ADDRESS as string]: token,
    [TOKEN_2022_PROGRAM_ADDRESS as string]: token,
  })
})()

/**
 * Read mint, owner and amount from a token account's data; `null` when it is too short to be one.
 */
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
    closeAuthority: view.getUint32(129, true) === 1 ? data.subarray(133, 165) : null,
  }
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])
export const optEqual = (a: Uint8Array | null, b: Uint8Array | null): boolean => (a === null || b === null ? a === b : bytesEqual(a, b))
export const pubkeyBytes = (address: string): Uint8Array => getAddressEncoder().encode(address as never) as Uint8Array
export const base64Bytes = (data: string): Uint8Array => getBase64Encoder().encode(data) as Uint8Array
