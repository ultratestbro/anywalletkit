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
import type { DecodedInstruction, SimulationResult, SolanaFeeQuote, TransactionDescription } from './types.js'

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
  /**
   * A bridge out of Solana: where the funds must arrive. Every top-level instruction must then be one the guard can
   * follow — compute budget, memos, LI.FI's tracking log, wSOL plumbing, transfers to this wallet's own accounts or to a
   * fee wallet (at most {@link BRIDGE_FEE_MAX_BPS} of what may leave), a Jupiter swap into this wallet or into the
   * bridge, and Mayan's Swift / MCTP / Fast MCTP order instructions — and every bridge order must name `recipient` on
   * `destChain`, a non-zero minimum, and (with `destToken` / `minAmountOut`) the reviewed token and a minimum no further
   * under the reviewed one than `slippageBps`. Anything else (a transfer to another wallet, an approval, a program whose
   * recipient cannot be read, a referrer or relayer fee over its cap) is refused (`bridge-*` codes).
   */
  bridgeOut?: BridgeOutExpectation
}

/** {@link SerializedExpectation.bridgeOut}. */
export interface BridgeOutExpectation {
  /** CAIP-2 id of the destination chain (an EVM chain Mayan serves: `eip155:1`, `eip155:8453`, …). */
  destChain: string
  /** The reviewed recipient there (0x-address). */
  recipient: string
  /** Wallets a route's fee may be paid to (SOL directly, tokens to their token accounts). Default: LI.FI's {@link LIFI_FEE_WALLET_ADDRESS}. */
  feeWallets?: readonly string[]
  /**
   * The reviewed destination token (0x-address; the zero address is the chain's native coin). Every order that names
   * its output token (Swift, the MCTP / Fast MCTP order modes) must name this one (`bridge-token`).
   */
  destToken?: string
  /**
   * The reviewed minimum the recipient receives, in the destination token's base units; needs `destDecimals`. Every
   * order's own minimum — Swift's `amountOutMin` (Mayan keeps at most 8 decimals), or for a plain MCTP / Fast MCTP
   * bridge of USDC the bridged amount less its relayer, Circle and referrer fees — must be at least this, less
   * `slippageBps` and 1 bp of rounding (`bridge-min`).
   */
  minAmountOut?: bigint
  /** Decimals of `destToken` on the destination chain. */
  destDecimals?: number
  /** How far under `minAmountOut` an order's own minimum may sit, in basis points (the plan's slippage). Default 0. */
  slippageBps?: number
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
  if (expect.bridgeOut !== undefined) {
    const b = expect.bridgeOut
    if (!b || typeof b.destChain !== 'string' || typeof b.recipient !== 'string' || (b.feeWallets !== undefined && (!Array.isArray(b.feeWallets) || b.feeWallets.some((w) => typeof w !== 'string')))) {
      throw new UnsafeTransactionError("The guard's bridgeOut needs a destChain and a recipient.", 'invalid-expectation', ['bridgeOut'])
    }
    const refuse = (what: string, why: string) => { throw new UnsafeTransactionError(`The guard's bridgeOut.${what} ${why}.`, 'invalid-expectation', [`bridgeOut.${what}`]) }
    if (b.destToken !== undefined && (typeof b.destToken !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(b.destToken))) refuse('destToken', 'is not a 0x-address')
    if (b.minAmountOut !== undefined) {
      bad('bridgeOut.minAmountOut', b.minAmountOut)
      if (!Number.isInteger(b.destDecimals) || b.destDecimals! < 0 || b.destDecimals! > 36) refuse('destDecimals', 'must be the destination token\'s decimals (0-36) when minAmountOut is set')
    }
    if (b.slippageBps !== undefined && (!Number.isInteger(b.slippageBps) || b.slippageBps < 0 || b.slippageBps >= 10_000)) refuse('slippageBps', 'must be whole basis points in [0, 10000)')
  }
}

/**
 * What the swap2 engine hands an account's `sendSerializedTransaction(serializedTx, expect)` hook for a provider-built
 * Solana leg (`SerializedExecutionExpectation` in `@anywalletkit/protocol-swap2-core`): JSON-safe base-unit strings.
 */
export interface SerializedExecutionInput {
  /** Most lamports the wallet may lose, fee excluded. */
  maxValueOut: string
  /** Same-chain swaps: the token that must arrive and its quoted minimum. */
  tokenIn?: { token: string; minAmount: string }
  /** Token sources: the token that may leave and the exact input. */
  source?: { token: string; maxAmount: string }
  /** Cross-chain legs: where the funds must arrive and the reviewed terms ({@link BridgeOutExpectation}). */
  bridgeOut?: { destChain: string; recipient: string; destToken?: string; minAmountOut?: string; destDecimals?: number; slippageBps?: number }
}

/**
 * The guard for `sendSerialized` / `checkSerialized` from the swap2 engine's expectation, every field carried over:
 * `maxValueOut` → `maxLamportsOut`, `tokenIn` → `tokenIn`, `source` → `maxTokenOut`, and `bridgeOut` with its reviewed
 * terms (`minAmountOut` as a bigint, kept only when `destDecimals` is known). Map the hook with it rather than by hand —
 * a bridge expectation that loses `bridgeOut` is checked against the SOL ceiling only:
 *
 * ```ts
 * sendSerializedTransaction: (tx, expect) => account.sendSerialized(tx, serializedGuardFromExecution(expect))
 * ```
 *
 * `extra` adds guard options (a program allowlist, instruction rules). A malformed amount throws `invalid-expectation`.
 */
export function serializedGuardFromExecution(expect: SerializedExecutionInput, extra: Omit<SerializedTxGuard, 'expect'> = {}): SerializedTxGuard {
  const amount = (what: string, v: unknown): bigint => {
    if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) throw new UnsafeTransactionError(`The swap2 expectation's ${what} is not a base-unit amount.`, 'invalid-expectation', [what])
    return BigInt(v)
  }
  if (!expect || typeof expect !== 'object') throw new UnsafeTransactionError('The guard has no expectation.', 'invalid-expectation')
  const b = expect.bridgeOut
  const terms = b && b.minAmountOut !== undefined && b.destDecimals !== undefined ? { minAmountOut: amount('bridgeOut.minAmountOut', b.minAmountOut), destDecimals: b.destDecimals } : {}
  const guard: SerializedTxGuard = {
    ...extra,
    expect: {
      maxLamportsOut: amount('maxValueOut', expect.maxValueOut),
      ...(expect.tokenIn ? { tokenIn: { mint: expect.tokenIn.token, minAmount: amount('tokenIn.minAmount', expect.tokenIn.minAmount) } } : {}),
      ...(expect.source ? { maxTokenOut: { mint: expect.source.token, amount: amount('source.maxAmount', expect.source.maxAmount) } } : {}),
      ...(b ? {
        bridgeOut: {
          destChain: b.destChain, recipient: b.recipient,
          ...(b.destToken !== undefined ? { destToken: b.destToken } : {}),
          ...terms,
          ...(b.slippageBps !== undefined ? { slippageBps: b.slippageBps } : {}),
        },
      } : {}),
    },
  }
  assertExpectation(guard.expect)
  return guard
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

/**
 * LI.FI's fee wallet on Solana: the `feeCollection` step of its Solana quotes pays SOL here and tokens to this wallet's
 * associated token accounts (every live cross-chain quote from Solana, 2026-10-09 … 2026-11-02).
 */
export const LIFI_FEE_WALLET_ADDRESS = '34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm'
/** The most a bridge transaction may pay to fee wallets, in basis points of what may leave the wallet (LI.FI takes 25). */
export const BRIDGE_FEE_MAX_BPS = 300n

/** Mayan order programs (swap-sdk `src/addresses.ts`) whose order instructions the guard reads. */
const MAYAN_SWIFT = ['BLZRi6frs4X4DNLw56V4EXai1b6QVESN1BhHBTYM9VcY', 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny']
const MAYAN_MCTP = 'dkpZqrxHFrhziEMQ931GLtfy11nFkCsfMftH9u6QwBU'
const MAYAN_FAST_MCTP = 'Gx9rivpS3YR8pBFwMuP6omYqVxunpLvLkNn7ubNyuZZ5'
const MAYAN_ORDER_PROGRAMS = new Set([...MAYAN_SWIFT, MAYAN_MCTP, MAYAN_FAST_MCTP])

/** Most a Mayan order may give a referrer or Mayan itself (`feeRateRef`, `feeRateMayan`), in basis points of the order. Every live LI.FI order of 2026-11-02 carries 0. */
export const MAYAN_REFERRER_FEE_MAX_BPS = 50
/**
 * Most a Mayan order's fixed relayer fees may take, in basis points of its input — Swift's submit / cancel / refund fees,
 * the MCTP order modes' redeem / Solana / refund / Circle fees, paid on the refund path whatever the order's minimum.
 * Live LI.FI orders of 2026-11-02 take at most 0.11 %.
 */
export const MAYAN_RELAYER_FEE_MAX_BPS = 1_000

/**
 * Mayan order instructions, by Anchor discriminator and exact data length (swap-sdk 15.3.0 `InitSwiftLayout`,
 * `MctpBridgeLedgerLayout`, `MctpSwapLedgerLayout`, `FastMctpBridgeLedgerLayout`, `FastMctpOrderLedgerLayout`): where
 * the 32-byte destination address sits, where the destination chain sits — a Wormhole chain id (u16) or a CCTP domain
 * (u32), little-endian — and which account holds the order's funds (Swift's `stateAccount`, the MCTP ledger's token
 * account). Account 0 is the trader, refunded on a cancel. Amounts are u64 LE: `amountInAt` the order's input,
 * `tokenOutAt` / `amountOutMinAt` its output token and minimum (orders that swap on the destination), `deductedAt` the
 * USDC fees a plain bridge takes from what it delivers, `refundFeesAt` the fixed relayer fees of an order that swaps,
 * `rateAt` its u8 fee rates in basis points.
 */
interface MayanOrderLayout {
  name: string; disc: string; length: number; recipientAt: number; chainAt: number; chain: 'wormhole' | 'cctp'; vaultAt: number
  amountInAt: number; tokenOutAt?: number; amountOutMinAt?: number; deductedAt?: readonly number[]; refundFeesAt?: readonly number[]; rateAt: readonly number[]
}
const MAYAN_ORDERS: readonly MayanOrderLayout[] = [
  // amountInMin@8 nativeInput@16 feeSubmit@17 destAddress@25 chain@57 tokenOut@59 amountOutMin@91 gasDrop@99 feeCancel@107 feeRefund@115 deadline@123 refAddress@131 feeRateRef@163 feeRateMayan@164
  { name: 'Swift init_order', disc: '204c290c27a284db', length: 198, recipientAt: 25, chainAt: 57, chain: 'wormhole', vaultAt: 3, amountInAt: 8, tokenOutAt: 59, amountOutMinAt: 91, refundFeesAt: [17, 107, 115], rateAt: [163, 164] },
  // destAddress@8 amountInMin@40 gasDrop@48 feeRedeem@56 feeSolana@64 chain@72 keyRnd@74 mode@106
  { name: 'MCTP init_bridge_ledger_gasless', disc: '3635a7a4fa097b45', length: 107, recipientAt: 8, chainAt: 72, chain: 'wormhole', vaultAt: 2, amountInAt: 40, deductedAt: [56, 64], rateAt: [] },
  // … mode@106 tokenOut@107 amountOutMin@139 deadline@147 refAddress@155 feeRateRef@187
  { name: 'MCTP init_order_ledger_gasless', disc: 'a06cdad95ee9a9ad', length: 188, recipientAt: 8, chainAt: 72, chain: 'wormhole', vaultAt: 2, amountInAt: 40, tokenOutAt: 107, amountOutMinAt: 139, refundFeesAt: [56, 64], rateAt: [187] },
  // destAddress@8 amountInMin@40 gasDrop@48 feeRedeem@56 feeSolana@64 domain@72 refAddress@76 feeRateRef@108 keyRnd@109 maxCircleFee@111 minFinality@119 mode@123
  { name: 'Fast MCTP init_bridge_ledger', disc: 'a766806a7976ba4c', length: 124, recipientAt: 8, chainAt: 72, chain: 'cctp', vaultAt: 3, amountInAt: 40, deductedAt: [56, 64, 111], rateAt: [108] },
  // destAddress@8 amountInMin@40 gasDrop@48 feeRedeem@56 feeRefund@64 feeSolana@72 domain@80 keyRnd@84 mode@86 tokenOut@87 amountOutMin@119 deadline@127 refAddress@135 feeRateRef@167 maxCircleFee@168
  { name: 'Fast MCTP init_order_ledger', disc: '8febfcc2d35a864d', length: 180, recipientAt: 8, chainAt: 80, chain: 'cctp', vaultAt: 3, amountInAt: 40, tokenOutAt: 87, amountOutMinAt: 119, refundFeesAt: [56, 64, 72, 168], rateAt: [167] },
]
/** Decimals of the USDC a plain MCTP / Fast MCTP bridge delivers (Circle's USDC on every chain Mayan's CCTP routes serve). */
const CCTP_USDC_DECIMALS = 6
/** Mayan normalizes an order's output amount to at most this many decimals (swap-sdk `getNormalizeFactor`). */
const MAYAN_MAX_DECIMALS = 8
/** Argument-less Mayan instructions that run an order the same transaction opened (`bridge`, `bridge_with_fee_shim`). */
const MAYAN_ORDER_FOLLOW_UPS = new Set(['ae29789262daa919', 'ebfc2bb26990c1a5'])

/** Mayan's chain ids for the EVM chains it serves (swap-sdk `src/utils.ts` evmChainIdMap, `src/cctp.ts` getCCTPDomain). */
const MAYAN_CHAINS: Readonly<Record<string, { wormhole: number; cctp?: number }>> = {
  'eip155:1': { wormhole: 2, cctp: 0 },
  'eip155:56': { wormhole: 4 },
  'eip155:137': { wormhole: 5, cctp: 7 },
  'eip155:43114': { wormhole: 6, cctp: 1 },
  'eip155:42161': { wormhole: 23, cctp: 3 },
  'eip155:10': { wormhole: 24, cctp: 2 },
  'eip155:8453': { wormhole: 30, cctp: 6 },
  'eip155:130': { wormhole: 44, cctp: 10 },
  'eip155:59144': { wormhole: 38, cctp: 11 },
  'eip155:146': { wormhole: 52, cctp: 13 },
  'eip155:999': { wormhole: 47, cctp: 19 },
  'eip155:143': { wormhole: 48, cctp: 15 },
}

/**
 * Jupiter v6 swaps the guard follows inside a bridge transaction: the account position of the swap's output (the
 * optional `destinationTokenAccount`, which is the Jupiter program id when absent, else the user's destination) and
 * where its fee arguments sit — the v2 routes' fixed `in_amount, quoted_out_amount, slippage_bps, platform_fee_bps,
 * positive_slippage_bps` at `argsAt` (before the route plan), the v1 routes' u8 `platform_fee_bps` as the last byte
 * (after it).
 */
const JUPITER_ROUTES: Readonly<Record<string, { optional?: number; destination: number; argsAt?: number }>> = {
  bb64facc31c4af14: { optional: 7, destination: 2, argsAt: 8 }, // route_v2
  d19853937cfed8e9: { destination: 5, argsAt: 9 }, // shared_accounts_route_v2 (id: u8 first)
  e517cb977ae3ad2a: { optional: 4, destination: 3 }, // route
  c1209b3341d69c81: { destination: 6 }, // shared_accounts_route
}

/** A Jupiter route's platform fee and positive-slippage share in bps (both must be 0 inside a bridge); undefined when the data is too short to hold them. */
function jupiterFees(route: { argsAt?: number }, d: Uint8Array): { platformFeeBps: number; positiveSlippageBps: number } | undefined {
  if (route.argsAt === undefined) return d.length > 8 ? { platformFeeBps: d[d.length - 1]!, positiveSlippageBps: 0 } : undefined
  if (d.length < route.argsAt + 22) return undefined
  return { platformFeeBps: u16le(d, route.argsAt + 18), positiveSlippageBps: u16le(d, route.argsAt + 20) }
}

const BRIDGE_PLUMBING = new Set<string>([COMPUTE_BUDGET_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS, MEMO_V1_PROGRAM_ADDRESS, LIFI_TRACKING_PROGRAM_ADDRESS])
const WSOL_PLUMBING = new Set(['SyncNative', 'InitializeImmutableOwner', 'GetAccountDataSize', 'AmountToUiAmount', 'UiAmountToAmount'])

/** A top-level instruction as it runs (Mayan's CPI proxy unwrapped), with every account resolved. */
export interface RunInstruction { program: string; accounts: readonly string[]; data: Uint8Array }

/** What a bridge check needs to know about the wallet's own accounts. */
export interface BridgeOutContext {
  wallet: string
  /** The token-account owner of `address` from its pre-state, or from an ATA creation in the same transaction. */
  tokenAccountOwner: (address: string) => string | undefined
  /** Most lamports / input tokens that may leave the wallet (the fee bound is a share of it). */
  maxLamportsOut: bigint
  maxTokenOut?: bigint
}

const u16le = (d: Uint8Array, at: number) => d[at]! | (d[at + 1]! << 8)
const u32le = (d: Uint8Array, at: number) => (d[at]! | (d[at + 1]! << 8) | (d[at + 2]! << 16) | (d[at + 3]! << 24)) >>> 0
const u64le = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true)

/**
 * Why a Mayan order does not deliver what was reviewed, or undefined: its fee rates and relayer fees within their caps,
 * a non-zero minimum, and — when the caller names them — the reviewed token and a minimum no further under the reviewed
 * one than the plan's slippage (+1 bp of rounding).
 */
function mayanOrderRefusal(layout: MayanOrderLayout, d: Uint8Array, b: BridgeOutExpectation): { code: string; detail: string; message: string } | undefined {
  const refuse = (code: string, detail: string, message: string) => ({ code, detail, message })
  for (const at of layout.rateAt) {
    if (d[at]! > MAYAN_REFERRER_FEE_MAX_BPS) return refuse('bridge-fee', String(d[at]), `The ${layout.name} order gives ${d[at]} bps to a referrer, more than ${MAYAN_REFERRER_FEE_MAX_BPS}.`)
  }
  const amountIn = u64le(d, layout.amountInAt)
  const rateBps = layout.rateAt.reduce((sum, at) => sum + BigInt(d[at]!), 0n)
  const keep = BigInt(10_000 - (b.slippageBps ?? 0) - 1)
  const reviewed = (decimals: number) => (b.minAmountOut! / 10n ** BigInt(Math.max(0, b.destDecimals! - decimals)) * keep) / 10_000n
  if (layout.tokenOutAt !== undefined && layout.amountOutMinAt !== undefined) {
    const fees = (layout.refundFeesAt ?? []).reduce((sum, at) => sum + u64le(d, at), 0n)
    if (fees * 10_000n > amountIn * BigInt(MAYAN_RELAYER_FEE_MAX_BPS)) return refuse('bridge-fee', String(fees), `The ${layout.name} order's relayer fees (${fees}) exceed ${MAYAN_RELAYER_FEE_MAX_BPS / 100}% of its input ${amountIn}.`)
    if (b.destToken !== undefined) {
      const tokenOut = hexOf(d.subarray(layout.tokenOutAt, layout.tokenOutAt + 32))
      const want = `${'00'.repeat(12)}${b.destToken.slice(2).toLowerCase()}`
      if (tokenOut !== want) return refuse('bridge-token', `0x${tokenOut}`, `The ${layout.name} order delivers token 0x${tokenOut}, not ${b.destToken}.`)
    }
    const min = u64le(d, layout.amountOutMinAt)
    if (min === 0n) return refuse('bridge-min', '0', `The ${layout.name} order accepts any output (minimum 0).`)
    if (b.minAmountOut !== undefined) {
      const floor = reviewed(Math.min(b.destDecimals!, MAYAN_MAX_DECIMALS))
      if (min < floor) return refuse('bridge-min', String(min), `The ${layout.name} order's minimum ${min} is under the reviewed ${b.minAmountOut} (${floor} at Mayan's precision, slippage included).`)
    }
    return undefined
  }
  // A plain USDC bridge: what arrives is the bridged amount less the fees taken from it.
  const deducted = (layout.deductedAt ?? []).reduce((sum, at) => sum + u64le(d, at), 0n) + (amountIn * rateBps) / 10_000n
  const delivered = amountIn > deducted ? amountIn - deducted : 0n
  if (delivered === 0n) return refuse('bridge-min', String(deducted), `The ${layout.name} order's fees (${deducted}) take all of its ${amountIn}.`)
  if (b.minAmountOut !== undefined) {
    if (b.destDecimals !== CCTP_USDC_DECIMALS) return refuse('bridge-token', String(b.destDecimals), `The ${layout.name} order delivers USDC (${CCTP_USDC_DECIMALS} decimals), not a token of ${b.destDecimals}.`)
    const floor = reviewed(CCTP_USDC_DECIMALS)
    if (delivered < floor) return refuse('bridge-min', String(delivered), `The ${layout.name} order delivers at least ${delivered} after its fees, under the reviewed ${b.minAmountOut} (slippage included).`)
  }
  return undefined
}

/**
 * Why a bridge transaction does not provably deliver to `bridgeOut.recipient`, or undefined when every instruction is
 * one the guard follows and every bridge order names the recipient (see {@link SerializedExpectation.bridgeOut}).
 * `items` is the description of `instructions`, index by index.
 */
export function bridgeOutRefusal(
  instructions: readonly RunInstruction[],
  items: readonly DecodedInstruction[],
  bridgeOut: BridgeOutExpectation,
  ctx: BridgeOutContext,
): { message: string; code: string; detail: string } | undefined {
  const refuse = (code: string, detail: string, message: string) => ({ code, detail, message })
  const chain = MAYAN_CHAINS[bridgeOut.destChain]
  if (!/^0x[0-9a-fA-F]{40}$/.test(bridgeOut.recipient)) return refuse('bridge-recipient', bridgeOut.recipient, `The bridge recipient ${bridgeOut.recipient || '(none)'} is not an EVM address; its bridge instruction cannot be checked.`)
  const want = `${'00'.repeat(12)}${bridgeOut.recipient.slice(2).toLowerCase()}`
  const fees = new Set(bridgeOut.feeWallets ?? [LIFI_FEE_WALLET_ADDRESS])
  const own = (address: string) => address === ctx.wallet || ctx.tokenAccountOwner(address) === ctx.wallet
  const feeAccount = (address: string) => fees.has(address) || fees.has(ctx.tokenAccountOwner(address) ?? '')

  // 1. Bridge orders: each must name the recipient on the destination chain; their vaults may receive the input.
  const bridgeAccounts = new Set<string>()
  let orders = 0
  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i]!
    if (!MAYAN_ORDER_PROGRAMS.has(ix.program)) continue
    const hex = hexOf(ix.data.subarray(0, 8))
    if (ix.data.length === 8 && MAYAN_ORDER_FOLLOW_UPS.has(hex)) continue
    const layout = MAYAN_ORDERS.find((o) => o.disc === hex && o.length === ix.data.length)
    if (!layout) return refuse('bridge-instruction', ix.program, `Instruction ${i} (${ix.program}, data ${hex}…) is no Mayan order the guard can read.`)
    const dest = layout.chain === 'wormhole' ? u16le(ix.data, layout.chainAt) : u32le(ix.data, layout.chainAt)
    const expected = layout.chain === 'wormhole' ? chain?.wormhole : chain?.cctp
    if (expected === undefined || dest !== expected) return refuse('bridge-recipient', String(dest), `The ${layout.name} order bridges to ${layout.chain} chain ${dest}, not ${bridgeOut.destChain}.`)
    const recipient = hexOf(ix.data.subarray(layout.recipientAt, layout.recipientAt + 32))
    if (recipient !== want) return refuse('bridge-recipient', recipient, `The ${layout.name} order pays 0x${recipient}, not ${bridgeOut.recipient}.`)
    if (ix.accounts[0] !== ctx.wallet) return refuse('bridge-recipient', ix.accounts[0] ?? '', `The ${layout.name} order names ${ix.accounts[0] ?? 'no account'} as its trader, not this wallet.`)
    const terms = mayanOrderRefusal(layout, ix.data, bridgeOut)
    if (terms) return terms
    const vault = ix.accounts[layout.vaultAt]
    if (vault === undefined) return refuse('bridge-instruction', ix.program, `The ${layout.name} order has no account ${layout.vaultAt}.`)
    bridgeAccounts.add(vault)
    orders++
  }
  if (orders === 0) return refuse('bridge-missing', bridgeOut.recipient, `The transaction carries no bridge order paying ${bridgeOut.recipient} on ${bridgeOut.destChain}.`)

  // 2. Everything else stays with the wallet, goes into the bridge, or pays a bounded fee.
  let feeLamports = 0n
  let feeTokens = 0n
  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i]!
    const it = items[i]
    if (MAYAN_ORDER_PROGRAMS.has(ix.program) || BRIDGE_PLUMBING.has(ix.program)) continue
    switch (it?.type) {
      case 'sol-transfer':
        if (own(it.to) || bridgeAccounts.has(it.to)) continue
        if (fees.has(it.to)) { feeLamports += it.lamports; continue }
        return refuse('bridge-payee', it.to, `Instruction ${i} sends ${it.lamports} lamports to ${it.to}, which is neither this wallet, the bridge nor a fee wallet.`)
      case 'token-transfer':
        if (own(it.destination) || bridgeAccounts.has(it.destination)) continue
        if (feeAccount(it.destination)) { feeTokens += it.amount; continue }
        return refuse('bridge-payee', it.destination, `Instruction ${i} sends ${it.amount} tokens to ${it.destination}, which is neither this wallet, the bridge nor a fee wallet.`)
      case 'ata-create':
      case 'close-account': // the rent comes back to this wallet (checked with the authorities)
      case 'compute-budget':
        continue
      case 'program-call':
        if ((ix.program === TOKEN_PROGRAM_ADDRESS || ix.program === TOKEN_2022_PROGRAM_ADDRESS) && it.instruction && WSOL_PLUMBING.has(it.instruction)) continue
        break
    }
    if (ix.program === JUPITER_V6_PROGRAM_ADDRESS) {
      const route = JUPITER_ROUTES[hexOf(ix.data.subarray(0, 8))]
      const optional = route?.optional !== undefined ? ix.accounts[route.optional] : undefined
      const out = route ? (optional !== undefined && optional !== JUPITER_V6_PROGRAM_ADDRESS ? optional : ix.accounts[route.destination]) : undefined
      if (out !== undefined && (own(out) || bridgeAccounts.has(out))) {
        // The route's own fee goes to a fee account the guard does not follow; the bridge's order minimums bind its price.
        const fees = jupiterFees(route!, ix.data)
        if (!fees) return refuse('bridge-instruction', ix.program, `Instruction ${i} is a Jupiter route too short to read its fees.`)
        if (fees.platformFeeBps !== 0 || fees.positiveSlippageBps !== 0) return refuse('bridge-fee', String(fees.platformFeeBps || fees.positiveSlippageBps), `Instruction ${i} is a Jupiter route that takes a platform fee (${fees.platformFeeBps} bps) or a positive-slippage share (${fees.positiveSlippageBps} bps).`)
        continue
      }
      return refuse('bridge-payee', out ?? ix.program, out ? `Instruction ${i} swaps into ${out}, which is neither this wallet nor the bridge.` : `Instruction ${i} is a Jupiter call whose output the guard cannot read.`)
    }
    return refuse('bridge-instruction', ix.program, `Instruction ${i} (${it?.type === 'program-call' && it.instruction ? it.instruction : 'program'} on ${ix.program}) has no place in a bridge the guard can follow.`)
  }
  if (feeLamports * 10_000n > ctx.maxLamportsOut * BRIDGE_FEE_MAX_BPS) return refuse('bridge-fee', String(feeLamports), `The transaction pays ${feeLamports} lamports in fees, more than ${BRIDGE_FEE_MAX_BPS / 100n}% of the ${ctx.maxLamportsOut} that may leave.`)
  if (feeTokens > 0n && (ctx.maxTokenOut === undefined || feeTokens * 10_000n > ctx.maxTokenOut * BRIDGE_FEE_MAX_BPS)) return refuse('bridge-fee', String(feeTokens), `The transaction pays ${feeTokens} input tokens in fees, more than ${BRIDGE_FEE_MAX_BPS / 100n}% of the input.`)
  return undefined
}
