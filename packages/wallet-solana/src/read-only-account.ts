import { NetworkError, type IWalletAccountReadOnly } from '@forgewallet/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  address, appendTransactionMessageInstructions, compileTransaction, compileTransactionMessage, compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner, createTransactionMessage, fetchAddressesForLookupTables, getAddressEncoder, getBase64Decoder, getBase64EncodedWireTransaction,
  getBase64Encoder, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder, getTransactionMessageComputeUnitLimit,
  getTransactionMessageComputeUnitPrice, isSignature, isSignerRole, isTransactionMessageWithBlockhashLifetime, isTransactionMessageWithDurableNonceLifetime,
  isWritableRole, pipe, setTransactionMessageComputeUnitLimit, setTransactionMessageComputeUnitPrice, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token'
import {
  TOKEN_2022_PROGRAM_ADDRESS, getMintDecoder, getTransferCheckedInstruction as getTransferChecked2022Instruction, getTransferCheckedWithFeeInstruction,
} from '@solana-program/token-2022'
import { MAX_U64, ZERO_ADDRESS, decodeWireTransaction, describeTransaction, resolveCompiledAccounts } from './describe.js'
import {
  DEFAULT_PROGRAM_ALLOWLIST, base64Bytes, bytesEqual, isNativeMint, parseTokenAccount, pubkeyBytes, type SerializedCheck, type SerializedTxGuard,
} from './serialized.js'
import { MissingSignersError, SimulationError, UnsafeTransactionError } from './errors.js'
import { isNativeTransfer, isSignedTransaction, isTransactionMessage } from './guards.js'
import { createRpc } from './rpc.js'
import {
  CAIP2_GENESIS, type SimulationResult, type SolanaConfig, type SolanaFeeQuote, type SolanaReceipt, type SolanaRpc, type SolanaTransaction,
  type SolanaTransferOptions, type TransactionDescription,
} from './types.js'

export { isNativeTransfer, isSignedTransaction, isTransactionMessage } from './guards.js'

const LAMPORTS_PER_SIGNATURE = 5_000n
const DEFAULT_MAX_PRIORITY = 5_000_000n
const CU_LIMIT_FOR_SIMULATION = 1_400_000
const CU_MIN = 1_000
const CU_MAX = 1_400_000
const CU_DEFAULT_PER_INSTRUCTION = 200_000
const utf8 = (s: string) => new TextEncoder().encode(s)
const hexToBytes = (h: string) => Uint8Array.from(h.replace(/^0x/, '').match(/.{2}/g) ?? [], (b) => parseInt(b, 16))
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/** Mint facts a token transfer needs; one `getAccountInfo` + (for fee mints) one `getEpochInfo`. */
export interface MintInfo {
  program: Address
  decimals: number
  /** Token-2022 TransferFee extension, resolved for the current epoch; undefined for plain mints. */
  transferFee?: { basisPoints: number; maximumFee: bigint }
}

/** A fully prepared transaction: what to sign, what it costs, what the simulation said and what it does. */
export interface SolanaPlan {
  /** Message-based inputs (transfers, messages): the final message with compute-budget instructions. */
  message?: TransactionMessage
  /** Compiled inputs (kit `Transaction` / base64 wire): the transaction as given. */
  transaction?: Transaction
  quote: SolanaFeeQuote
  simulation: SimulationResult | undefined
  description: TransactionDescription
}

/** `getRecentPrioritizationFees` percentile (75th) over the given accounts, clamped to the configured range. */
export function pickPriorityPrice(fees: ReadonlyArray<bigint | number>, min: bigint, max: bigint): bigint {
  const sorted = fees.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  let price = 0n
  if (sorted.length) {
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))
    price = sorted[idx]!
  }
  if (price < min) price = min
  if (price > max) price = max
  return price
}

/** Compute-unit limit from a simulation: ×1.1, clamped. */
export function computeUnitLimitFromSimulation(unitsConsumed: bigint): number {
  const padded = Number((unitsConsumed * 11n + 9n) / 10n)
  return Math.min(CU_MAX, Math.max(CU_MIN, padded))
}

/**
 * A simulation `err` as text. `@solana/kit` parses every JSON integer in an
 * RPC response as a bigint, so a structured error such as
 * `{InstructionError: [2n, {Custom: 6001n}]}` made a plain JSON.stringify
 * throw "Do not know how to serialize a BigInt" — and that message replaced
 * the real on-chain failure (Solana USDe → SOL via LI.FI, Oct 16 run).
 */
function describeSimulationErr(err: unknown): string {
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  } catch {
    return String(err)
  }
}

export class WalletAccountReadOnlySolana implements IWalletAccountReadOnly {
  readonly address: Address
  readonly chain: string
  protected readonly _config: SolanaConfig
  protected readonly _rpc: SolanaRpc | undefined
  protected readonly _commitment

  constructor(addr: string, config: SolanaConfig = {}) {
    this.address = address(addr)
    this._config = config
    this._rpc = createRpc(config)
    this._commitment = config.commitment ?? 'confirmed'
    const net = config.network ?? 'mainnet'
    this.chain = CAIP2_GENESIS[net] ?? (net.startsWith('solana:') ? net : `solana:${net}`)
  }

  protected requireRpc(what: string): SolanaRpc {
    if (!this._rpc) throw new NetworkError(`The wallet must be connected to a provider to ${what}.`)
    return this._rpc
  }

  async getAddress(): Promise<string> { return this.address }

  async getBalance(): Promise<bigint> {
    const { value } = await this.requireRpc('retrieve balances').getBalance(this.address, { commitment: this._commitment }).send()
    return value
  }

  // ── Mints and token accounts ────────────────────────────────────────────────

  /** Mint owner program, decimals and (Token-2022) the transfer fee in force this epoch. */
  async getMintInfo(mint: string): Promise<MintInfo> {
    const rpc = this.requireRpc('read mints')
    const info = await rpc.getAccountInfo(address(mint), { commitment: this._commitment, encoding: 'base64' }).send()
    if (!info.value) throw new Error(`Mint ${mint} does not exist on this network.`)
    const program = info.value.owner
    const bytes = getBase64Encoder().encode(info.value.data[0]) as Uint8Array
    if (program !== TOKEN_PROGRAM_ADDRESS && program !== TOKEN_2022_PROGRAM_ADDRESS) throw new Error(`${mint} is not a token mint (owner ${program}).`)
    if (bytes.length < 45) throw new Error(`${mint} is not a token mint (account too small).`)
    const out: MintInfo = { program, decimals: bytes[44]! }
    if (program === TOKEN_2022_PROGRAM_ADDRESS) {
      const decoded = getMintDecoder().decode(bytes)
      const exts = decoded.extensions.__option === 'Some' ? decoded.extensions.value : []
      const feeCfg = exts.find((e) => e.__kind === 'TransferFeeConfig')
      if (feeCfg && feeCfg.__kind === 'TransferFeeConfig') {
        const { epoch } = await rpc.getEpochInfo({ commitment: this._commitment }).send()
        const fee = epoch >= feeCfg.newerTransferFee.epoch ? feeCfg.newerTransferFee : feeCfg.olderTransferFee
        if (fee.transferFeeBasisPoints > 0) out.transferFee = { basisPoints: fee.transferFeeBasisPoints, maximumFee: fee.maximumFee }
      }
    }
    return out
  }

  /** Token-2022 transfer fee for `amount` under `info` (0 for plain mints). */
  static transferFeeFor(info: MintInfo, amount: bigint): bigint {
    if (!info.transferFee) return 0n
    const raw = ceilDiv(amount * BigInt(info.transferFee.basisPoints), 10_000n)
    return raw > info.transferFee.maximumFee ? info.transferFee.maximumFee : raw
  }

  protected async ata(mint: Address, owner: Address, tokenProgram: Address = TOKEN_PROGRAM_ADDRESS): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram })
    return ata
  }

  async getTokenBalance(token: string): Promise<bigint> {
    const rpc = this.requireRpc('retrieve token balances')
    const mint = address(token)
    const { program } = await this.getMintInfo(token).catch(() => ({ program: TOKEN_PROGRAM_ADDRESS }))
    const ata = await this.ata(mint, this.address, program)
    const info = await rpc.getAccountInfo(ata, { commitment: this._commitment, encoding: 'base64' }).send()
    if (!info.value) return 0n
    const bal = await rpc.getTokenAccountBalance(ata, { commitment: this._commitment }).send()
    return BigInt(bal.value.amount)
  }

  /** Batched over getMultipleAccounts (100 per call); amount read from the token-account layout at offset 64. Legacy-program ATAs. */
  async getTokenBalances(tokens: string[]): Promise<Record<string, bigint>> {
    const rpc = this.requireRpc('retrieve token balances')
    const unique = [...new Set(tokens)]
    const atas = await Promise.all(unique.map((t) => this.ata(address(t), this.address)))
    const out: Record<string, bigint> = {}
    const b64 = getBase64Encoder()
    for (let i = 0; i < atas.length; i += 100) {
      const { value } = await rpc.getMultipleAccounts(atas.slice(i, i + 100), { commitment: this._commitment, encoding: 'base64' }).send()
      value.forEach((acc, j) => {
        const token = unique[i + j]!
        if (!acc) { out[token] = 0n; return }
        const bytes = b64.encode(acc.data[0])
        out[token] = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true)
      })
    }
    return out
  }

  // ── Message construction ────────────────────────────────────────────────────

  protected async latestBlockhash() {
    const { value } = await this.requireRpc('fetch a blockhash').getLatestBlockhash({ commitment: this._commitment }).send()
    return value
  }

  private async newMessage(instructions: Instruction[]): Promise<TransactionMessage> {
    const bh = await this.latestBlockhash()
    return pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(this.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ) as TransactionMessage
  }

  protected async buildNativeTransfer(to: string, value: bigint | number | string): Promise<TransactionMessage> {
    const ix = getTransferSolInstruction({ source: createNoopSigner(this.address), destination: address(to), amount: BigInt(value) })
    return this.newMessage([ix])
  }

  /** SPL / Token-2022 transfer via `transferChecked` (mint + decimals verified on chain); the recipient ATA is created when missing. */
  protected async buildTokenTransfer(token: string, recipient: string, amount: bigint | number | string): Promise<{ message: TransactionMessage; tokenFee: bigint }> {
    const amt = BigInt(amount)
    if (amt > MAX_U64) throw new Error('Amount exceeds u64 maximum value')
    const rpc = this.requireRpc('transfer tokens')
    const mint = address(token)
    const to = address(recipient)
    const info = await this.getMintInfo(token)
    const [fromAta, toAta] = await Promise.all([this.ata(mint, this.address, info.program), this.ata(mint, to, info.program)])
    const instructions: Instruction[] = []
    const toInfo = await rpc.getAccountInfo(toAta, { commitment: this._commitment, encoding: 'base64' }).send()
    const payer = createNoopSigner(this.address)
    if (!toInfo.value) instructions.push(getCreateAssociatedTokenIdempotentInstruction({ ata: toAta, mint, owner: to, payer, tokenProgram: info.program }))
    const tokenFee = WalletAccountReadOnlySolana.transferFeeFor(info, amt)
    const base = { source: fromAta, mint, destination: toAta, authority: payer, amount: amt, decimals: info.decimals }
    if (info.program === TOKEN_2022_PROGRAM_ADDRESS) {
      instructions.push(info.transferFee ? getTransferCheckedWithFeeInstruction({ ...base, fee: tokenFee }) : getTransferChecked2022Instruction(base))
    } else {
      instructions.push(getTransferCheckedInstruction(base))
    }
    return { message: await this.newMessage(instructions), tokenFee }
  }

  /** Normalise `{to, value}` or a kit message into a message with lifetime + this account as fee payer. */
  protected async prepareMessage(tx: SolanaTransaction): Promise<TransactionMessage> {
    let msg: TransactionMessage
    if (isNativeTransfer(tx)) msg = await this.buildNativeTransfer(tx.to, tx.value)
    else if (isTransactionMessage(tx)) msg = tx
    else throw new Error('Expected a {to, value} transfer or a transaction message.')
    if (!isTransactionMessageWithBlockhashLifetime(msg) && !isTransactionMessageWithDurableNonceLifetime(msg)) {
      msg = setTransactionMessageLifetimeUsingBlockhash(await this.latestBlockhash(), msg) as TransactionMessage
    }
    const payer = (msg as { feePayer?: Address | { address: Address } }).feePayer
    const payerAddress = typeof payer === 'string' ? payer : payer?.address
    if (payerAddress !== undefined && payerAddress !== this.address && !this._config.allowForeignFeePayer) {
      throw new UnsafeTransactionError(`Transaction fee payer (${payerAddress}) does not match wallet address (${this.address}).`)
    }
    return payerAddress === undefined ? (setTransactionMessageFeePayer(this.address, msg as never) as TransactionMessage) : msg
  }

  /** Compress a v0 message with the given address lookup tables (fetched from the RPC). */
  protected async withLookupTables(msg: TransactionMessage, tables: string[] | undefined): Promise<TransactionMessage> {
    if (!tables?.length) return msg
    if (msg.version !== 0) throw new Error('Address lookup tables need a version 0 transaction message.')
    const rpc = this.requireRpc('fetch address lookup tables')
    const byTable = await fetchAddressesForLookupTables(tables.map(address), rpc as never)
    return compressTransactionMessageUsingAddressLookupTables(msg as never, byTable) as TransactionMessage
  }

  // ── Compute budget, simulation, planning ────────────────────────────────────

  private budgetPolicy(): { price: bigint | 'auto' | undefined; limit: number | 'auto' | undefined } {
    const cfg = this._config.priorityFee
    if (cfg === false) return { price: undefined, limit: undefined }
    const auto = this._rpc !== undefined
    const price = cfg?.microLamports ?? (auto ? 'auto' : undefined)
    const limit = cfg?.computeUnitLimit ?? (auto ? 'auto' : undefined)
    return { price: price === 'auto' ? 'auto' : price === undefined ? undefined : BigInt(price), limit }
  }

  private writableAccounts(msg: TransactionMessage): Address[] {
    const set = new Set<Address>([this.address])
    for (const ix of msg.instructions) for (const a of ix.accounts ?? []) if (isWritableRole(a.role)) set.add(a.address)
    return [...set]
  }

  private signerCount(msg: TransactionMessage): number {
    const set = new Set<string>([this.address])
    for (const ix of msg.instructions) for (const a of ix.accounts ?? []) if (isSignerRole(a.role)) set.add(a.address)
    return set.size
  }

  /** Wire bytes with all-zero signatures — what `simulateTransaction({sigVerify: false})` accepts. */
  private unsignedWire(msg: TransactionMessage): string {
    return getBase64EncodedWireTransaction(compileTransaction(msg as never) as Transaction)
  }

  private async simulateWire(wire: string): Promise<SimulationResult> {
    const rpc = this.requireRpc('simulate transactions')
    const { value } = await rpc.simulateTransaction(wire as never, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: this._commitment }).send()
    const logs = value.logs ?? []
    if (value.err) return { ok: false, error: describeSimulationErr(value.err), logs }
    return { ok: true, unitsConsumed: value.unitsConsumed ?? 0n, logs }
  }

  /** `simulateTransaction` for any accepted input; never throws for an on-chain failure, only for transport errors. */
  async simulateTransaction(tx: SolanaTransaction): Promise<SimulationResult> {
    if (typeof tx === 'string') return this.simulateWire(tx)
    if (isSignedTransaction(tx)) return this.simulateWire(getBase64EncodedWireTransaction(tx))
    const msg = await this.withLookupTables(await this.prepareMessage(tx), isNativeTransfer(tx) ? tx.lookupTables : undefined)
    return this.simulateWire(this.unsignedWire(msg))
  }

  /** Hard checks shared by every signing path. */
  protected enforce(description: TransactionDescription): void {
    const burn = description.warnings.find((w) => w.code === 'burn-address')
    if (burn && !this._config.allowBurn) throw new UnsafeTransactionError(`${burn.message} Set allowBurn to override.`)
    if (description.feePayer && description.feePayer !== this.address && !this._config.allowForeignFeePayer) {
      throw new UnsafeTransactionError(`Transaction fee payer (${description.feePayer}) does not match wallet address (${this.address}). Set allowForeignFeePayer to override.`)
    }
  }

  /**
   * Plan a message-based transaction: lookup tables, compute budget (priority
   * price + unit limit), simulation and the fee quote. Shared by quote / sign /
   * send so the network is consulted once per fact.
   */
  protected async planMessage(input: TransactionMessage, opts: { lookupTables?: string[] | undefined; tokenFee?: bigint | undefined; simulate?: boolean | undefined } = {}): Promise<SolanaPlan> {
    let msg = await this.withLookupTables(input, opts.lookupTables)
    const description = describeTransaction(msg, { account: this.address })
    this.enforce(description)

    const policy = this.budgetPolicy()
    const explicitPrice = getTransactionMessageComputeUnitPrice(msg as never)
    const explicitLimit = getTransactionMessageComputeUnitLimit(msg)
    let price: bigint = explicitPrice ?? 0n
    if (explicitPrice === undefined && policy.price !== undefined) {
      if (policy.price === 'auto') {
        const fees = await this.requireRpc('read prioritization fees').getRecentPrioritizationFees(this.writableAccounts(msg)).send()
        const min = BigInt(this._config.minPriorityMicroLamports ?? 0)
        const max = BigInt(this._config.maxPriorityMicroLamports ?? DEFAULT_MAX_PRIORITY)
        price = pickPriorityPrice(fees.map((f) => f.prioritizationFee), min, max)
      } else price = policy.price
    }
    let limit: number | undefined = explicitLimit ?? (typeof policy.limit === 'number' ? policy.limit : undefined)
    const wantAutoLimit = explicitLimit === undefined && policy.limit === 'auto'
    const simulate = this._rpc !== undefined && (opts.simulate ?? this._config.simulate) !== false

    let simulation: SimulationResult | undefined
    if (simulate || wantAutoLimit) {
      if (price > 0n) msg = setTransactionMessageComputeUnitPrice(price, msg as never) as TransactionMessage
      const probe = wantAutoLimit ? setTransactionMessageComputeUnitLimit(CU_LIMIT_FOR_SIMULATION, msg) : msg
      simulation = await this.simulateWire(this.unsignedWire(probe))
      if (!simulation.ok) {
        if (simulate) throw new SimulationError(simulation.error, simulation.logs)
        simulation = undefined
      } else if (wantAutoLimit) limit = computeUnitLimitFromSimulation(simulation.unitsConsumed)
    }
    if (price > 0n && explicitPrice === undefined) msg = setTransactionMessageComputeUnitPrice(price, msg as never) as TransactionMessage
    if (limit !== undefined && explicitLimit === undefined) msg = setTransactionMessageComputeUnitLimit(limit, msg)

    const nonBudgetIxs = description.items.filter((i) => i.type !== 'compute-budget').length
    const chargedLimit = limit ?? Math.min(CU_MAX, CU_DEFAULT_PER_INSTRUCTION * Math.max(1, nonBudgetIxs))
    const priorityFee = price > 0n ? ceilDiv(BigInt(chargedLimit) * price, 1_000_000n) : 0n
    const baseFee = LAMPORTS_PER_SIGNATURE * BigInt(this.signerCount(msg))
    const rpcFee = await this.feeForMessage(msg)
    const fee = rpcFee > baseFee + priorityFee ? rpcFee : baseFee + priorityFee
    const quote: SolanaFeeQuote = { fee, baseFee, priorityFee, microLamports: price, computeUnitLimit: limit, ...(opts.tokenFee !== undefined ? { tokenFee: opts.tokenFee } : {}) }
    return { message: msg, quote, simulation, description: describeTransaction(msg, { account: this.address }) }
  }

  /** Signer checks shared by every compiled-transaction path: this wallet must be a required signer and nobody else may still be missing. */
  protected enforceCompiledSigners(description: TransactionDescription): void {
    this.enforce(description)
    if (!description.signers.some((s) => s.address === this.address)) throw new UnsafeTransactionError('This wallet is not a required signer of the transaction.')
    const missing = description.signers.filter((s) => s.signed === false && s.address !== this.address).map((s) => s.address)
    if (missing.length) throw new MissingSignersError(missing)
  }

  /** Plan a compiled transaction (kit `Transaction` or base64 wire): hard checks, simulation, fee quote. The bytes are never altered. */
  protected async planCompiled(input: Transaction | string, opts: { simulate?: boolean | undefined } = {}): Promise<SolanaPlan> {
    const transaction = typeof input === 'string' ? decodeWireTransaction(input) : input
    const description = describeTransaction(transaction, { account: this.address })
    this.enforceCompiledSigners(description)

    let simulation: SimulationResult | undefined
    if (this._rpc !== undefined && (opts.simulate ?? this._config.simulate) !== false) {
      simulation = await this.simulateWire(getBase64EncodedWireTransaction(transaction))
      if (!simulation.ok) throw new SimulationError(simulation.error, simulation.logs)
    }
    return { transaction, quote: await this.quoteCompiled(transaction, description), simulation, description }
  }

  /** Fee of a compiled transaction: signatures + the compute budget it carries, floored by the RPC's own quote. */
  protected async quoteCompiled(transaction: Transaction, description: TransactionDescription): Promise<SolanaFeeQuote> {
    let price = 0n
    let limit: number | undefined
    for (const it of description.items) {
      if (it.type !== 'compute-budget') continue
      if (it.kind === 'price') price = it.value
      if (it.kind === 'limit') limit = Number(it.value)
    }
    const nonBudgetIxs = description.items.filter((i) => i.type !== 'compute-budget').length
    const chargedLimit = limit ?? Math.min(CU_MAX, CU_DEFAULT_PER_INSTRUCTION * Math.max(1, nonBudgetIxs))
    const priorityFee = price > 0n ? ceilDiv(BigInt(chargedLimit) * price, 1_000_000n) : 0n
    const baseFee = LAMPORTS_PER_SIGNATURE * BigInt(description.signers.length)
    const rpcFee = await this.feeForBase64(getBase64Decoder().decode(transaction.messageBytes))
    const fee = rpcFee > baseFee + priorityFee ? rpcFee : baseFee + priorityFee
    return { fee, baseFee, priorityFee, microLamports: price, computeUnitLimit: limit }
  }

  // ── Provider-built (serialized) transactions ────────────────────────────────

  /** Addresses of a lookup-table set, fetched once; `undefined` when the message uses none. */
  protected async lookupAddresses(tables: readonly string[]): Promise<Record<string, readonly string[]> | undefined> {
    if (!tables.length) return undefined
    const rpc = this.requireRpc('fetch address lookup tables')
    const byTable = await fetchAddressesForLookupTables(tables.map(address), rpc as never)
    return byTable as unknown as Record<string, readonly string[]>
  }

  private async accountStates(addresses: readonly string[]): Promise<Map<string, { lamports: bigint; owner: string; data: Uint8Array } | null>> {
    const rpc = this.requireRpc('read accounts')
    const out = new Map<string, { lamports: bigint; owner: string; data: Uint8Array } | null>()
    const unique = [...new Set(addresses)]
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100)
      const { value } = await rpc.getMultipleAccounts(chunk.map(address), { commitment: this._commitment, encoding: 'base64' }).send()
      chunk.forEach((addr, j) => {
        const acc = value[j]
        out.set(addr, acc ? { lamports: BigInt(acc.lamports), owner: acc.owner as string, data: base64Bytes(acc.data[0]) } : null)
      })
    }
    return out
  }

  /**
   * Prove what a provider-built transaction does before anyone signs it (see
   * `serialized.ts`). Throws {@link UnsafeTransactionError} (allowlist, authority
   * changes, balance violations), {@link MissingSignersError} or
   * {@link SimulationError}; returns the evidence otherwise. Nothing is signed.
   */
  async checkSerialized(base64: string, guard: SerializedTxGuard): Promise<SerializedCheck> {
    const rpc = this.requireRpc('check provider transactions')
    const transaction = decodeWireTransaction(base64)
    const layout0 = resolveCompiledAccounts(transaction)
    const addressesByLookupTableAddress = await this.lookupAddresses(layout0.tables)
    const ctx = { account: this.address as string, ...(addressesByLookupTableAddress ? { addressesByLookupTableAddress } : {}) }
    const description = describeTransaction(transaction, ctx)
    const layout = resolveCompiledAccounts(transaction, ctx)
    if (layout.unresolved) throw new UnsafeTransactionError('Some accounts come from lookup tables that could not be resolved; the transaction cannot be audited.', 'unresolved-lookup-tables')
    this.enforceCompiledSigners(description)

    // 1. Programs.
    if (!guard.allowUnknownPrograms) {
      const allowed = new Set(guard.programAllowlist ?? DEFAULT_PROGRAM_ALLOWLIST)
      const foreign = [...new Set(description.items.map((it) => it.program ?? '<unresolved>').filter((p) => !allowed.has(p)))]
      if (foreign.length) throw new UnsafeTransactionError(`Transaction invokes programs outside the allowlist: ${foreign.join(', ')}.`, 'unknown-program', foreign)
    }
    // 2. Authority changes are never part of a swap. Closing a token account
    //    is routine (aggregators unwrap temporary wSOL) ONLY when the rent
    //    comes back to this wallet. A delegate approval is accepted ONLY on
    //    the declared swap-input account, bounded by the declared amount, and
    //    only if the simulation shows the delegate fully spent afterwards
    //    (Relay's depository pulls the deposit via delegate in the same
    //    transaction, 2026-10-09) — a lingering allowance is refused below.
    const { expect } = guard
    const approvals: Array<{ source: string; delegate: string }> = []
    for (const it of description.items) {
      if (it.type === 'set-authority') throw new UnsafeTransactionError(`Transaction changes an authority on ${it.account}.`, 'sets-authority', [it.account])
      if (it.type === 'token-approve') {
        if (it.unlimited || !expect.maxTokenOut || isNativeMint(expect.maxTokenOut.mint) || it.amount > expect.maxTokenOut.amount) {
          throw new UnsafeTransactionError(`Transaction approves ${it.delegate} to spend from ${it.source}.`, 'approves-delegate', [it.delegate])
        }
        approvals.push({ source: it.source, delegate: it.delegate })
      }
      if (it.type === 'close-account' && it.destination !== this.address) throw new UnsafeTransactionError(`Transaction closes ${it.account} with the rent sent to ${it.destination}.`, 'closes-account', [it.account])
    }

    // 3. Balances: pre-state of every writable account plus the declared ATAs,
    //    post-state from a simulation that returns those same accounts.
    const me = pubkeyBytes(this.address)
    const mintAtas = async (mint: string) => Promise.all([this.ata(address(mint), this.address, TOKEN_PROGRAM_ADDRESS), this.ata(address(mint), this.address, TOKEN_2022_PROGRAM_ADDRESS)])
    const tokenInNative = expect.tokenIn !== undefined && isNativeMint(expect.tokenIn.mint)
    const tokenInAtas = expect.tokenIn && !tokenInNative ? (await mintAtas(expect.tokenIn.mint)).map(String) : []
    const tokenOutAtas = expect.maxTokenOut && !isNativeMint(expect.maxTokenOut.mint) ? (await mintAtas(expect.maxTokenOut.mint)).map(String) : []
    const writable = layout.accounts.filter((a) => isWritableRole(a.role) && a.address !== null).map((a) => a.address as string)
    const pre = await this.accountStates([this.address, ...tokenInAtas, ...tokenOutAtas, ...writable])
    const isTokenProgram = (owner: string) => owner === TOKEN_PROGRAM_ADDRESS || owner === TOKEN_2022_PROGRAM_ADDRESS
    const ownedTokenAccounts = writable.filter((addr) => {
      const st = pre.get(addr)
      if (!st || !isTokenProgram(st.owner)) return false
      const parsed = parseTokenAccount(st.data)
      return parsed !== null && bytesEqual(parsed.owner, me)
    })
    const watched = [...new Set([this.address as string, ...tokenInAtas, ...tokenOutAtas, ...ownedTokenAccounts])]

    const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction) as never, {
      encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: this._commitment, accounts: { addresses: watched.map(address), encoding: 'base64' },
    }).send()
    const logs = value.logs ?? []
    if (value.err) throw new SimulationError(describeSimulationErr(value.err), logs)
    const postList = (value as { accounts?: Array<{ lamports: bigint | number; owner: string; data: readonly [string, string] } | null> }).accounts
    if (!postList || postList.length !== watched.length) throw new NetworkError('simulateTransaction did not return the requested post-state accounts.')
    const post = new Map<string, { lamports: bigint; owner: string; data: Uint8Array } | null>()
    watched.forEach((addr, i) => { const acc = postList[i]; post.set(addr, acc ? { lamports: BigInt(acc.lamports), owner: acc.owner, data: base64Bytes(acc.data[0]) } : null) })

    const quote = await this.quoteCompiled(transaction, description)
    const lamports = (m: Map<string, { lamports: bigint } | null>, addr: string) => m.get(addr)?.lamports ?? 0n
    const tokenAmount = (m: Map<string, { data: Uint8Array } | null>, addr: string) => { const st = m.get(addr); return st ? (parseTokenAccount(st.data)?.amount ?? 0n) : 0n }
    const tokenDelta = (atas: readonly string[]) => atas.reduce((sum, a) => sum + tokenAmount(post, a) - tokenAmount(pre, a), 0n)

    const lamportsDelta = lamports(post, this.address) - lamports(pre, this.address)
    const ceiling = expect.maxLamportsOut + quote.fee
    if (lamportsDelta < -ceiling) throw new UnsafeTransactionError(`Transaction spends ${-lamportsDelta} lamports; at most ${ceiling} (${expect.maxLamportsOut} + fee ${quote.fee}) allowed.`, 'lamports-out', [String(-lamportsDelta)])

    let tokenInDelta: bigint | undefined
    if (expect.tokenIn) {
      if (tokenInNative) {
        // Receiving SOL: the net change must cover the minimum after the allowed spend.
        if (lamportsDelta < expect.tokenIn.minAmount - ceiling) throw new UnsafeTransactionError(`Transaction yields ${lamportsDelta} lamports net; at least ${expect.tokenIn.minAmount - ceiling} expected.`, 'slippage', [String(lamportsDelta)])
      } else {
        tokenInDelta = tokenDelta(tokenInAtas)
        if (tokenInDelta < expect.tokenIn.minAmount) throw new UnsafeTransactionError(`Transaction delivers ${tokenInDelta} of ${expect.tokenIn.mint}; at least ${expect.tokenIn.minAmount} expected.`, 'slippage', [String(tokenInDelta)])
      }
    }
    let tokenOutDelta: bigint | undefined
    if (expect.maxTokenOut && !isNativeMint(expect.maxTokenOut.mint)) {
      tokenOutDelta = tokenDelta(tokenOutAtas)
      if (tokenOutDelta < -expect.maxTokenOut.amount) throw new UnsafeTransactionError(`Transaction takes ${-tokenOutDelta} of ${expect.maxTokenOut.mint}; at most ${expect.maxTokenOut.amount} allowed.`, 'token-out', [String(-tokenOutDelta)])
    }
    for (const ap of approvals) {
      if (!tokenOutAtas.includes(ap.source)) throw new UnsafeTransactionError(`Transaction approves ${ap.delegate} to spend from ${ap.source}, which is not the swap input.`, 'approves-delegate', [ap.delegate])
      const st = post.get(ap.source)
      const parsed = st ? parseTokenAccount(st.data) : null
      if (parsed && parsed.delegate !== null && parsed.delegatedAmount > 0n) {
        throw new UnsafeTransactionError(`Transaction leaves ${ap.delegate} approved for ${parsed.delegatedAmount} on ${ap.source} after it runs.`, 'approves-delegate', [ap.delegate])
      }
    }
    const exempt = new Set([...tokenInAtas, ...tokenOutAtas])
    for (const addr of ownedTokenAccounts) {
      if (exempt.has(addr)) continue
      const before = tokenAmount(pre, addr)
      const after = tokenAmount(post, addr)
      if (after < before) throw new UnsafeTransactionError(`Transaction drains ${before - after} from token account ${addr}, which is not part of the swap.`, 'token-drain', [addr])
    }
    return { description, simulation: { ok: true, unitsConsumed: value.unitsConsumed ?? 0n, logs }, quote, lamportsDelta, tokenInDelta, tokenOutDelta, watched }
  }

  /** {@link checkSerialized} without throwing for a refusal: the check or the reason. */
  async simulateSerialized(base64: string, guard: SerializedTxGuard): Promise<{ ok: true; check: SerializedCheck } | { ok: false; reason: string; code?: string }> {
    try {
      return { ok: true, check: await this.checkSerialized(base64, guard) }
    } catch (e) {
      if (e instanceof NetworkError) throw e
      const code = e instanceof UnsafeTransactionError ? e.code : e instanceof SimulationError ? 'simulation' : e instanceof MissingSignersError ? 'missing-signers' : undefined
      return { ok: false, reason: e instanceof Error ? e.message : String(e), ...(code ? { code } : {}) }
    }
  }

  /** Plan any accepted input. */
  protected async plan(tx: SolanaTransaction, opts: { simulate?: boolean | undefined } = {}): Promise<SolanaPlan> {
    if (typeof tx === 'string' || isSignedTransaction(tx)) return this.planCompiled(tx, opts)
    return this.planMessage(await this.prepareMessage(tx), { ...opts, lookupTables: isNativeTransfer(tx) ? tx.lookupTables : undefined })
  }

  protected async planTransfer(o: SolanaTransferOptions, opts: { simulate?: boolean | undefined } = {}): Promise<SolanaPlan> {
    if (o.token) {
      const { message, tokenFee } = await this.buildTokenTransfer(o.token, o.recipient, o.amount)
      return this.planMessage(message, { ...opts, lookupTables: o.lookupTables, tokenFee })
    }
    return this.planMessage(await this.buildNativeTransfer(o.recipient, o.amount), { ...opts, lookupTables: o.lookupTables })
  }

  // ── Fees and receipts ───────────────────────────────────────────────────────

  protected async feeForMessage(msg: TransactionMessage): Promise<bigint> {
    const b64 = pipe(msg as never, compileTransactionMessage, getCompiledTransactionMessageEncoder().encode, getBase64Decoder().decode)
    return this.feeForBase64(b64)
  }

  protected async feeForBase64(messageBase64: string): Promise<bigint> {
    const { value } = await this.requireRpc('quote transactions').getFeeForMessage(messageBase64 as never, { commitment: this._commitment }).send()
    if (value === null || value === undefined) throw new Error('Failed to calculate transaction fee')
    return BigInt(value)
  }

  /** Full fee breakdown (base + priority, Token-2022 fee for transfers). Simulation runs too, so a reverting tx is reported here. */
  async quoteSendTransaction(tx: SolanaTransaction): Promise<SolanaFeeQuote> {
    return (await this.plan(tx)).quote
  }

  async quoteTransfer(o: SolanaTransferOptions): Promise<SolanaFeeQuote> {
    return (await this.planTransfer(o)).quote
  }

  /** Decode without the network: what the transaction does and what to be wary of. */
  describeTransaction(tx: SolanaTransaction): TransactionDescription {
    return describeTransaction(tx, { account: this.address })
  }

  async getTransactionReceipt(hash: string): Promise<SolanaReceipt | undefined> {
    const rpc = this.requireRpc('fetch transaction receipts')
    if (!isSignature(hash)) throw new Error('Invalid signature.')
    const tx = await rpc.getTransaction(hash, { commitment: this._commitment, maxSupportedTransactionVersion: 0, encoding: 'json' }).send()
    if (!tx) return undefined
    return { hash, status: tx.meta?.err ? 0 : 1, blockNumber: BigInt(tx.slot), fee: BigInt(tx.meta?.fee ?? 0), blockTime: tx.blockTime === null || tx.blockTime === undefined ? null : Number(tx.blockTime), err: tx.meta?.err ?? null }
  }

  /** ed25519 over the UTF-8 message; `signature` hex. */
  async verify(message: string | Uint8Array, signature: string): Promise<boolean> {
    const pub = getAddressEncoder().encode(this.address) as Uint8Array
    try { return ed25519.verify(hexToBytes(signature), typeof message === 'string' ? utf8(message) : message, pub) } catch { return false }
  }
}


