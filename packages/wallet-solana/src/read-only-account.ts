import { NetworkError, NotATokenError, type IWalletAccountReadOnly, type TokenInfo, bigintToNumber } from '@anywalletkit/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  address, appendTransactionMessageInstructions, compileTransaction, compileTransactionMessage, compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner, createTransactionMessage, fetchAddressesForLookupTables, getAddressEncoder, getBase64Decoder, getBase64EncodedWireTransaction,
  getAddressDecoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder, getProgramDerivedAddress, getTransactionMessageComputeUnitLimit,
  getTransactionMessageComputeUnitPrice, isSignature, isSignerRole, isTransactionMessageWithBlockhashLifetime, isTransactionMessageWithDurableNonceLifetime,
  isWritableRole, pipe, setTransactionMessageComputeUnitLimit, setTransactionMessageComputeUnitPrice, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { SYSTEM_PROGRAM_ADDRESS, getTransferSolInstruction } from '@solana-program/system'
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token'
import {
  TOKEN_2022_PROGRAM_ADDRESS, getMintDecoder, getTransferCheckedInstruction as getTransferChecked2022Instruction, getTransferCheckedWithFeeInstruction,
} from '@solana-program/token-2022'
import { MAX_U64, STAKE_PROGRAM_ADDRESS, ZERO_ADDRESS, decodeWireTransaction, describeTransaction, resolveCompiledAccounts } from './describe.js'
import {
  DEFAULT_PROGRAM_ALLOWLIST, SAFE_CORE_INSTRUCTIONS, WSOL_MINT, assertExpectation, base64Bytes, bytesEqual, isNativeMint, optEqual, parseTokenAccount, pubkeyBytes, unexpectedInstruction,
  type SerializedCheck, type SerializedTxGuard, type SolanaAccountData,
} from './serialized.js'
import { MissingSignersError, SimulationError, UnsafeTransactionError } from './errors.js'
import { isNativeTransfer, isSignedTransaction, isTransactionMessage } from './guards.js'
import { createRpc } from './rpc.js'
import { METAPLEX_METADATA_PROGRAM, parseMetaplexMetadata, parseMint } from './token-info.js'
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
/** The amount of a token account holding `mint` (layout: mint 0..32, amount at 64), or undefined for anything else. */
function tokenAmountOf(bytes: Uint8Array, mint: Address): bigint | undefined {
  if (bytes.length < 165) return undefined
  const expected = getAddressEncoder().encode(mint)
  for (let k = 0; k < 32; k++) if (bytes[k] !== expected[k]) return undefined
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true)
}

/** What a plan may be told per call: skip simulation, sign a durable-nonce transaction (round 3, M9). */
export interface PlanOptions { simulate?: boolean | undefined; allowDurableNonce?: boolean | undefined }

const CORE_PROGRAMS = new Set<string>([SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS])

/** An account as `getMultipleAccounts` / a simulation's post-state returns it. */
type AccountState = { lamports: bigint; owner: string; data: Uint8Array }
const isTokenProgram = (owner: string): boolean => owner === TOKEN_PROGRAM_ADDRESS || owner === TOKEN_2022_PROGRAM_ADDRESS
/** Token account data, not a mint: a Token-2022 account longer than the base layout carries its type at byte 165 (2 = Account). */
const isTokenAccountData = (owner: string, data: Uint8Array): boolean => data.length === 165 || (owner === TOKEN_2022_PROGRAM_ADDRESS && data.length > 165 && data[165] === 2)
/** Account keys one transaction can hold (u8 indexes); a simulation returns post-state for at most that many. */
const MAX_TRANSACTION_ACCOUNTS = 256
/** System instructions that hand an account (or a nonce account's authority) of the signer to a program or someone else. */
const WALLET_SYSTEM_INSTRUCTIONS = new Set(['Assign', 'AssignWithSeed', 'Allocate', 'AllocateWithSeed', 'AuthorizeNonceAccount', 'CreateAccountAllowPrefund'])
/** Token / Token-2022 instructions that hand an authority away (`SetAuthority` and the metadata / group interfaces). */
const TOKEN_AUTHORITY_INSTRUCTIONS = new Set(['SetAuthority', 'UpdateTokenMetadataUpdateAuthority', 'UpdateTokenGroupUpdateAuthority'])
/** A Stake account's space: AllocateWithSeed of exactly this, owned by Stake, is how a pre-funded seed slot is taken back. */
const STAKE_ACCOUNT_SPACE = 200n
/**
 * What the wallet may put into a stake account it only splits into (its authorities are the split
 * source's, which the guard cannot read): the account's rent reserve, with margin — never real money.
 */
const SPLIT_PREFUND_CAP = 5_000_000n
/** `Pubkey::default()`: an Initialize lockup with this custodian has none. */
const NO_CUSTODIAN = '11111111111111111111111111111111'
/** Undecoded core instructions that move lamports, with the index of the account they go to: refused unless that is this wallet. */
const LAMPORT_DESTINATIONS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  [SYSTEM_PROGRAM_ADDRESS]: { WithdrawNonceAccount: 1, TransferSolWithSeed: 2 },
  [TOKEN_PROGRAM_ADDRESS]: { CloseAccount: 1, WithdrawExcessLamports: 1, UnwrapLamports: 1 },
  [TOKEN_2022_PROGRAM_ADDRESS]: { CloseAccount: 1, WithdrawExcessLamports: 1, UnwrapLamports: 1 },
}
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
  const padded = bigintToNumber((unitsConsumed * 11n + 9n) / 10n)
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
    return JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? bigintToNumber(v) : v))
  } catch {
    return String(err)
  }
}

/**
 * A Solana address without a key: balances, mint info, fee quotes, simulation, the serialized-
 * transaction guard, receipts and signature checks.
 */
export class WalletAccountReadOnlySolana implements IWalletAccountReadOnly {
  /** Base58 address. */
  readonly address: Address
  /** CAIP-2 id of the cluster. */
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

  /** The base58 address. */
  async getAddress(): Promise<string> { return this.address }

  /** Native balance in lamports. */
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

  /**
   * The owner of a Token / Token-2022 token account — whom an SPL transfer into it pays — or
   * undefined when the address holds no initialized token account (a wallet, a mint, nothing).
   * Network errors throw. The kit's policies read SPL transfer recipients through it.
   */
  async getTokenAccountOwner(tokenAccount: string): Promise<string | undefined> {
    let at: Address
    try { at = address(tokenAccount) } catch { return undefined }
    const rpc = this.requireRpc('read token accounts')
    const info = await rpc.getAccountInfo(at, { commitment: this._commitment, encoding: 'base64' }).send()
    const v = info.value
    if (!v || (v.owner !== TOKEN_PROGRAM_ADDRESS && v.owner !== TOKEN_2022_PROGRAM_ADDRESS)) return undefined
    const bytes = getBase64Encoder().encode(v.data[0]) as Uint8Array
    // Account layout: mint 0..32, owner 32..64, state at 108 (0 = uninitialized). Token-2022 tags
    // an extended account at 165 (2 = Account; a mint with extensions carries 1 there).
    if (bytes.length < 165 || (bytes.length > 165 && bytes[165] !== 2) || bytes[108] === 0) return undefined
    return getAddressDecoder().decode(bytes.subarray(32, 64))
  }

  /**
   * Decimals, symbol, name, supply and the holder-relevant flags of a mint, read from the chain: a
   * live mint or freeze authority, and the Token-2022 extensions that let someone take, tax, hook,
   * freeze or pause holders' tokens. Name and symbol come from the Token-2022 metadata extension,
   * else from the Metaplex metadata account ("" when there is neither). Throws
   * {@link NotATokenError} when the address is not an initialized Token / Token-2022 mint.
   */
  async getTokenInfo(token: string): Promise<TokenInfo> {
    let mint: Address
    try {
      mint = address(token)
    } catch {
      throw new NotATokenError(token, 'not a base58 Solana address')
    }
    const rpc = this.requireRpc('read token info')
    const info = await rpc.getAccountInfo(mint, { commitment: this._commitment, encoding: 'base64' }).send()
    if (!info.value) throw new NotATokenError(mint, 'no account at this address')
    const program = info.value.owner
    const token2022 = program === TOKEN_2022_PROGRAM_ADDRESS
    if (program !== TOKEN_PROGRAM_ADDRESS && !token2022) throw new NotATokenError(mint, `the account belongs to ${program}, not a token program`)
    const parsed = parseMint(getBase64Encoder().encode(info.value.data[0]) as Uint8Array, token2022)
    if (!parsed) throw new NotATokenError(mint, 'the account is not an initialized mint')
    let name = parsed.name
    let symbol = parsed.symbol
    if (name === undefined || symbol === undefined) {
      const mintBytes = getAddressEncoder().encode(mint) as Uint8Array
      const [pda] = await getProgramDerivedAddress({
        programAddress: address(METAPLEX_METADATA_PROGRAM),
        seeds: [utf8('metadata'), getAddressEncoder().encode(address(METAPLEX_METADATA_PROGRAM)), mintBytes],
      })
      const meta = await rpc.getAccountInfo(pda, { commitment: this._commitment, encoding: 'base64' }).send()
      const fields = meta.value && meta.value.owner === METAPLEX_METADATA_PROGRAM
        ? parseMetaplexMetadata(getBase64Encoder().encode(meta.value.data[0]) as Uint8Array, mintBytes)
        : null
      name = fields?.name ?? ''
      symbol = fields?.symbol ?? ''
    }
    return { address: mint, standard: token2022 ? 'spl-token-2022' : 'spl', decimals: parsed.decimals, symbol, name, totalSupply: parsed.supply, flags: parsed.flags }
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

  /**
   * Balance of a mint in this wallet's associated token account (Token or Token-2022, whichever
   * owns the mint), in base units; 0 when that account does not exist or the address is not a
   * mint. A network error throws: it is never read as a zero balance (round 3, L10).
   */
  async getTokenBalance(token: string): Promise<bigint> {
    const rpc = this.requireRpc('retrieve token balances')
    const mint = address(token)
    const { value } = await rpc.getAccountInfo(mint, { commitment: this._commitment, encoding: 'base64' }).send()
    if (!value || (value.owner !== TOKEN_PROGRAM_ADDRESS && value.owner !== TOKEN_2022_PROGRAM_ADDRESS)) return 0n
    const ata = await this.ata(mint, this.address, value.owner)
    const info = await rpc.getAccountInfo(ata, { commitment: this._commitment, encoding: 'base64' }).send()
    return info.value ? (tokenAmountOf(getBase64Encoder().encode(info.value.data[0]) as Uint8Array, mint) ?? 0n) : 0n
  }

  /**
   * Batched over getMultipleAccounts (100 addresses per call). Both programs' associated token
   * accounts are read for every mint, so Token-2022 balances count (round 3, L10); the amount comes
   * from the token-account layout (offset 64) of the account that holds that mint.
   */
  async getTokenBalances(tokens: string[]): Promise<Record<string, bigint>> {
    const rpc = this.requireRpc('retrieve token balances')
    const unique = [...new Set(tokens)]
    const pairs = await Promise.all(unique.map(async (t) => {
      const mint = address(t)
      return { token: t, mint, atas: await Promise.all([this.ata(mint, this.address, TOKEN_PROGRAM_ADDRESS), this.ata(mint, this.address, TOKEN_2022_PROGRAM_ADDRESS)]) }
    }))
    const all = pairs.flatMap((p) => p.atas)
    const found = new Map<string, Uint8Array>()
    const b64 = getBase64Encoder()
    for (let i = 0; i < all.length; i += 100) {
      const chunk = all.slice(i, i + 100)
      const { value } = await rpc.getMultipleAccounts(chunk, { commitment: this._commitment, encoding: 'base64' }).send()
      value.forEach((acc, j) => {
        if (acc && (acc.owner === TOKEN_PROGRAM_ADDRESS || acc.owner === TOKEN_2022_PROGRAM_ADDRESS)) found.set(chunk[j]!, b64.encode(acc.data[0]) as Uint8Array)
      })
    }
    const out: Record<string, bigint> = {}
    for (const p of pairs) out[p.token] = p.atas.reduce((sum, a) => { const bytes = found.get(a); return sum + (bytes ? (tokenAmountOf(bytes, p.mint) ?? 0n) : 0n) }, 0n)
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

  /**
   * A transfer's recipient must be a wallet (round 3, M10). A token account or a mint as recipient
   * gets an associated token account nobody can sign for, and SOL or tokens sent to a program are
   * lost: an account owned by Token / Token-2022, or an executable one, is refused. An address with
   * no account yet is an ordinary wallet.
   */
  protected async assertWalletRecipient(recipient: string): Promise<void> {
    const rpc = this.requireRpc('check the recipient')
    const { value } = await rpc.getAccountInfo(address(recipient), { commitment: this._commitment, encoding: 'base64' }).send()
    if (!value) return
    if (value.executable) throw new UnsafeTransactionError(`Recipient ${recipient} is a program, not a wallet: what is sent there is lost.`, 'recipient-not-wallet', [recipient])
    if (value.owner === TOKEN_PROGRAM_ADDRESS || value.owner === TOKEN_2022_PROGRAM_ADDRESS) {
      throw new UnsafeTransactionError(`Recipient ${recipient} is a token account or a mint, not a wallet: send to the owner's wallet address.`, 'recipient-not-wallet', [recipient])
    }
  }

  /** SPL / Token-2022 transfer via `transferChecked` (mint + decimals verified on chain); the recipient ATA is created when missing. */
  protected async buildTokenTransfer(token: string, recipient: string, amount: bigint | number | string): Promise<{ message: TransactionMessage; tokenFee: bigint }> {
    const amt = BigInt(amount)
    if (amt > MAX_U64) throw new Error('Amount exceeds u64 maximum value')
    const rpc = this.requireRpc('transfer tokens')
    const mint = address(token)
    const to = address(recipient)
    await this.assertWalletRecipient(recipient)
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

  /**
   * Accounts whose simulated post-state the CPI guard reads, beyond the wallet: this wallet's token accounts the
   * transaction writes, and every written account that does not exist yet (or is a bare, data-less System account):
   * the transaction may create it as a token account of this wallet, with a delegate or close authority already
   * planted by CPI (scan 2026-10-28 F3). Nothing else can turn into a token account: only the System program can
   * assign an account, and only while it has no data.
   */
  private cpiWatched(written: readonly string[], pre: ReadonlyMap<string, AccountState | null>): string[] {
    const me = pubkeyBytes(this.address)
    return [...new Set(written)].filter((a) => {
      if (a === this.address) return false
      const st = pre.get(a)
      if (!st) return true
      if (st.owner === SYSTEM_PROGRAM_ADDRESS && st.data.length === 0) return true
      const t = isTokenProgram(st.owner) ? parseTokenAccount(st.data) : null
      return t !== null && bytesEqual(t.owner, me)
    })
  }

  /**
   * One watched account's authorities after the transaction against before it (`hint` ends the message). A token
   * account that did not exist, or was not one, counts as this wallet's with no delegate and no close authority:
   * anything else it ends up with was set by the transaction. A new token account of someone else is no concern of
   * this wallet's, except at this wallet's own associated address, which then belongs to another owner.
   */
  private async cpiAuthorityRefusal(addr: string, before: AccountState | null | undefined, after: AccountState | null | undefined, approved: boolean, hint: string): Promise<UnsafeTransactionError | null> {
    const me = pubkeyBytes(this.address)
    const prior = before && isTokenProgram(before.owner) ? parseTokenAccount(before.data) : null
    const wasMine = prior !== null && bytesEqual(prior.owner, me)
    const t = after && isTokenProgram(after.owner) && isTokenAccountData(after.owner, after.data) ? parseTokenAccount(after.data) : null
    if (!t) return null // closed (lamports out are what the description and the fee guard show), or not a token account
    if (!wasMine && prior !== null) return null // someone else's token account before: not this wallet's to judge
    if (!bytesEqual(t.owner, me)) {
      if (wasMine) return new UnsafeTransactionError(`Transaction changes the owner of token account ${addr}${hint}`, 'sets-authority', [addr])
      const ownAta = String(await this.ata(getAddressDecoder().decode(t.mint), this.address, after!.owner as Address))
      return ownAta === addr ? new UnsafeTransactionError(`Transaction creates this wallet's associated token account ${addr} owned by someone else${hint}`, 'sets-authority', [addr]) : null
    }
    const was = prior ?? { closeAuthority: null, delegate: null, delegatedAmount: 0n }
    if (!optEqual(was.closeAuthority, t.closeAuthority)) return new UnsafeTransactionError(`Transaction changes who may close token account ${addr}${hint}`, 'sets-authority', [addr])
    const live = t.delegate !== null && t.delegatedAmount > 0n
    const same = optEqual(was.delegate, t.delegate) && t.delegatedAmount <= was.delegatedAmount
    if (live && !same && !approved) return new UnsafeTransactionError(`Transaction leaves a delegate allowance on token account ${addr} that no top-level Approve shows${hint}`, 'approves-delegate', [addr])
    return null
  }

  /**
   * The simulation a signing path runs, which also proves what the transaction does to this wallet
   * beyond its top-level instructions (round 3, CPI guard). Those checks cannot see what a program
   * the wallet signs for does by CPI, so the simulation returns the post-state of this wallet, of
   * its token accounts the transaction writes and of every written account it may create (see
   * {@link cpiWatched}), and the guard refuses: the wallet's account handed to a program or given
   * data, a token account's owner or close authority changed or set on a new one, a delegate
   * allowance set or raised that no top-level Approve shows, this wallet's associated token account
   * created for another owner. `allowAuthorityChanges` skips it. One extra read (the pre-state of
   * the written accounts); a node that does not return the post-state it was asked for is a
   * {@link NetworkError}. The node returns post-state for at most as many addresses as the
   * transaction has accounts: every address asked for is one of them, so the list always fits.
   */
  private async simulateGuarded(wire: string, written: readonly string[], description: TransactionDescription): Promise<SimulationResult> {
    if (this._config.allowAuthorityChanges) return this.simulateWire(wire)
    const rpc = this.requireRpc('simulate transactions')
    const others = [...new Set(written.filter((a) => a !== this.address))]
    const pre = others.length ? await this.accountStates(others) : new Map<string, AccountState | null>()
    const mine = this.cpiWatched(others, pre)
    const watched = [this.address as string, ...mine]
    // Every watched address is a distinct account of the transaction (the fee payer or a written one), within the node's limit.
    if (watched.length > MAX_TRANSACTION_ACCOUNTS) throw new UnsafeTransactionError(`Transaction writes ${watched.length} accounts; the simulation cannot return them all.`, 'too-many-accounts')
    const { value } = await rpc.simulateTransaction(wire as never, {
      encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: this._commitment, accounts: { addresses: watched.map(address), encoding: 'base64' },
    }).send()
    const logs = value.logs ?? []
    if (value.err) return { ok: false, error: describeSimulationErr(value.err), logs }
    const postList = (value as { accounts?: Array<{ owner: string; data: readonly [string, string] } | null> }).accounts
    if (!postList || postList.length !== watched.length) throw new NetworkError('simulateTransaction did not return the requested post-state accounts.')
    const wallet = postList[0]
    if (wallet && (wallet.owner !== SYSTEM_PROGRAM_ADDRESS || base64Bytes(wallet.data[0]).length > 0)) {
      throw new UnsafeTransactionError(`Transaction would ${wallet.owner !== SYSTEM_PROGRAM_ADDRESS ? `hand this wallet's account to ${wallet.owner}` : "give this wallet's account data"} (a program it signs for does it by CPI). Set allowAuthorityChanges to override.`, 'wallet-owner', [this.address])
    }
    const approvedOnTop = new Set(description.items.flatMap((it) => (it.type === 'token-approve' ? [it.source] : [])))
    for (const [k, addr] of mine.entries()) {
      const st = postList[k + 1]
      const after = st ? { lamports: 0n, owner: st.owner, data: base64Bytes(st.data[0]) } : null
      const refusal = await this.cpiAuthorityRefusal(addr, pre.get(addr), after, approvedOnTop.has(addr), ' (by CPI). Set allowAuthorityChanges to override.')
      if (refusal) throw refusal
    }
    return { ok: true, unitsConsumed: value.unitsConsumed ?? 0n, logs }
  }

  /** `simulateTransaction` for any accepted input; never throws for an on-chain failure, only for transport errors. */
  async simulateTransaction(tx: SolanaTransaction): Promise<SimulationResult> {
    if (typeof tx === 'string') return this.simulateWire(tx)
    if (isSignedTransaction(tx)) return this.simulateWire(getBase64EncodedWireTransaction(tx))
    const msg = await this.withLookupTables(await this.prepareMessage(tx), isNativeTransfer(tx) ? tx.lookupTables : undefined)
    return this.simulateWire(this.unsignedWire(msg))
  }

  /** Hard checks shared by every signing path. `options` carries the per-call opt-ins ({@link SolanaWriteOptions}). */
  protected enforce(description: TransactionDescription, options: { allowDurableNonce?: boolean | undefined } = {}): void {
    if (description.lifetime === 'durable-nonce' && !(options.allowDurableNonce ?? this._config.allowDurableNonce)) {
      throw new UnsafeTransactionError('Refusing a durable-nonce transaction: its signature never expires and can be broadcast at any later time. Set allowDurableNonce (config or call options) to override.', 'durable-nonce')
    }
    const burn = description.warnings.find((w) => w.code === 'burn-address')
    if (burn && !this._config.allowBurn) throw new UnsafeTransactionError(`${burn.message} Set allowBurn to override.`)
    if (description.feePayer && description.feePayer !== this.address && !this._config.allowForeignFeePayer) {
      throw new UnsafeTransactionError(`Transaction fee payer (${description.feePayer}) does not match wallet address (${this.address}). Set allowForeignFeePayer to override.`)
    }
    if (!this._config.allowAuthorityChanges) this.enforceAuthorities(description)
  }

  /**
   * The drainer shapes a wallet never signs by default: this wallet's account reassigned, allocated
   * or created under a program; a nonce, token, metadata or group authority handed away; lamports
   * moved out by an instruction the description does not show as a transfer (a token account
   * closed, excess or wrapped lamports withdrawn, a nonce or seed account emptied) to anyone but
   * this wallet; a token `Batch` (it can carry any of these); an undecodable System / Token
   * instruction. Instructions whose accounts sit in unresolved lookup tables are judged by their
   * identified name (this wallet, a signer, is always a static key). A program this wallet signs
   * for can still do any of this by CPI; `sendSerialized` proves the outcome by simulation instead.
   */
  protected enforceAuthorities(description: TransactionDescription): void {
    const hint = ' Set allowAuthorityChanges to override.'
    const settled = this.ownStakeAccounts(description)
    for (const it of description.items) {
      if (it.type === 'create-account' && it.owner === STAKE_PROGRAM_ADDRESS && it.payer === this.address && !settled.has(it.newAccount)) {
        // An uninitialized stake account takes Initialize from anyone: funding one is handing it over
        // unless this same message makes this wallet its staker and withdrawer.
        throw new UnsafeTransactionError(`Transaction funds stake account ${it.newAccount} without making this wallet its staker and withdrawer.${hint}`, 'sets-authority', [it.newAccount])
      }
      if ((it.type === 'program-call' || it.type === 'unknown') && it.program === STAKE_PROGRAM_ADDRESS) { this.enforceStake(it, hint); continue }
      if (it.type === 'set-authority') throw new UnsafeTransactionError(`Transaction changes an authority on ${it.account}.${hint}`, 'sets-authority', [it.account])
      if (it.type === 'close-account' && it.destination !== this.address) {
        throw new UnsafeTransactionError(`Transaction closes ${it.account} with the rent sent to ${it.destination}.${hint}`, 'closes-account', [it.account])
      }
      if (it.type === 'create-account' && it.newAccount === this.address) {
        throw new UnsafeTransactionError(`Transaction creates this wallet's own account (${this.address}) under program ${it.owner}.${hint}`, 'core-instruction', [it.program])
      }
      if ((it.type !== 'program-call' && it.type !== 'unknown') || !it.program || !CORE_PROGRAMS.has(it.program)) continue
      const name = it.instruction
      if (name === undefined) throw new UnsafeTransactionError(`Transaction runs an undecodable instruction on core program ${it.program}.${hint}`, 'core-instruction', [it.program])
      const system = it.program === SYSTEM_PROGRAM_ADDRESS
      // CreateAccountAllowPrefund: only the NEW account (index 0) matters; the wallet may just pay for it.
      const touches = name === 'CreateAccountAllowPrefund' ? it.accounts[0] === this.address : it.accounts.includes(this.address)
      // Taking back a seed slot someone pre-funded (native staking): this wallet's own seed account
      // becomes a 200-byte Stake account that this message initializes for, or splits into from, this wallet.
      const seedSlot = it.type === 'program-call' && name === 'AllocateWithSeed' && it.withSeed !== undefined && it.withSeed.base === this.address &&
        it.withSeed.owner === STAKE_PROGRAM_ADDRESS && it.withSeed.space === STAKE_ACCOUNT_SPACE && it.accounts[0] !== undefined && settled.has(it.accounts[0])
      if (system && WALLET_SYSTEM_INSTRUCTIONS.has(name) && touches && !seedSlot) {
        throw new UnsafeTransactionError(`Transaction runs ${name} on an account of this wallet (${this.address}).${hint}`, 'core-instruction', [it.program])
      }
      if (!system && name === 'Batch') throw new UnsafeTransactionError(`Transaction runs a token Batch, whose inner instructions are not checked.${hint}`, 'core-instruction', [it.program])
      if (!system && TOKEN_AUTHORITY_INSTRUCTIONS.has(name)) {
        throw new UnsafeTransactionError(`Transaction changes an authority on ${it.accounts[0] ?? 'an unresolved account'} (${name}).${hint}`, 'sets-authority', [it.accounts[0] ?? it.program])
      }
      const to = LAMPORT_DESTINATIONS[it.program]?.[name]
      if (to !== undefined && it.accounts[to] !== this.address) {
        const where = it.accounts[to] ?? 'an unresolved account'
        if (name === 'CloseAccount') throw new UnsafeTransactionError(`Transaction closes ${it.accounts[0] ?? 'a token account'} with the rent sent to ${where}.${hint}`, 'closes-account', [it.accounts[0] ?? it.program])
        throw new UnsafeTransactionError(`Transaction moves lamports to ${where} with ${name}.${hint}`, 'moves-lamports', [it.accounts[0] ?? it.program])
      }
    }
  }

  /**
   * Stake accounts this message leaves to this wallet: initialized with this wallet as staker and
   * withdrawer and no lockup, or the destination of a Split this wallet signs (a split copies the
   * source's authorities).
   */
  private ownStakeAccounts(description: TransactionDescription): Set<string> {
    const own = new Set<string>()
    // Lamports this wallet puts into each account in this message.
    const funded = new Map<string, bigint>()
    const fund = (to: string, lamports: bigint) => funded.set(to, (funded.get(to) ?? 0n) + lamports)
    for (const it of description.items) {
      if (it.type === 'create-account' && it.payer === this.address) fund(it.newAccount, it.lamports)
      if (it.type === 'sol-transfer' && it.from === this.address) fund(it.to, it.lamports)
    }
    for (const it of description.items) {
      if ((it.type !== 'program-call' && it.type !== 'unknown') || it.program !== STAKE_PROGRAM_ADDRESS || !it.stake) continue
      const target = it.accounts[it.stake.name === 'Split' ? 1 : 0]
      if (!target) continue
      const s = it.stake
      // A split copies the SOURCE's authorities (anyone may Initialize a stake account naming this
      // wallet as staker and another withdrawer): its destination is this wallet's only up to rent.
      if (s.name === 'Split' && it.accounts[2] === this.address && (funded.get(target) ?? 0n) <= SPLIT_PREFUND_CAP) own.add(target)
      const unlocked = (s.lockupTimestamp ?? 0n) === 0n && (s.lockupEpoch ?? 0n) === 0n && (s.custodian === undefined || s.custodian === NO_CUSTODIAN || s.custodian === this.address)
      if ((s.name === 'Initialize' || s.name === 'InitializeChecked') && s.staker === this.address && s.withdrawer === this.address && unlocked) own.add(target)
    }
    return own
  }

  /**
   * A Stake instruction that names this wallet must not hand a stake account, or its lamports, to
   * anyone else: `Authorize*` to another key, `Withdraw` to another recipient, `SetLockup*` with a
   * foreign custodian or a lockup. The program takes its authorities from any signer of the
   * instruction and has two account layouts, so the wallet's position is not what decides: if it is
   * in the instruction at all, the instruction is judged. An undecodable one is refused.
   */
  private enforceStake(it: Extract<TransactionDescription['items'][number], { type: 'program-call' | 'unknown' }>, hint: string): void {
    const me = this.address
    const at = (n: number) => it.accounts[n] ?? undefined
    const s = it.stake
    const account = at(0) ?? 'an unresolved stake account'
    if (!s) {
      if (it.accounts.includes(me)) throw new UnsafeTransactionError(`Transaction runs an undecodable Stake instruction that names this wallet.${hint}`, 'core-instruction', [it.program ?? STAKE_PROGRAM_ADDRESS])
      return
    }
    if (!it.accounts.includes(me)) return
    if (s.name === 'Authorize' || s.name === 'AuthorizeWithSeed' || s.name === 'AuthorizeChecked' || s.name === 'AuthorizeCheckedWithSeed') {
      if (s.newAuthority !== me) throw new UnsafeTransactionError(`Transaction makes ${s.newAuthority ?? 'an unresolved account'} the ${s.authorityType ?? ''} authority of stake account ${account}.${hint}`, 'sets-authority', [account])
    }
    if (s.name === 'Withdraw' && at(1) !== me) {
      throw new UnsafeTransactionError(`Transaction withdraws ${s.lamports ?? 0n} lamports from stake account ${account} to ${at(1) ?? 'an unresolved account'}.${hint}`, 'moves-lamports', [account])
    }
    if (s.name === 'SetLockup' || s.name === 'SetLockupChecked') {
      const foreign = s.custodian !== undefined && s.custodian !== me
      const locks = (s.lockupTimestamp ?? 0n) !== 0n || (s.lockupEpoch ?? 0n) !== 0n
      if (foreign || locks) throw new UnsafeTransactionError(`Transaction sets a lockup${foreign ? ` with custodian ${s.custodian}` : ''} on stake account ${account}.${hint}`, 'sets-authority', [account])
    }
  }

  /**
   * Plan a message-based transaction: lookup tables, compute budget (priority
   * price + unit limit), simulation and the fee quote. Shared by quote / sign /
   * send so the network is consulted once per fact.
   */
  protected async planMessage(input: TransactionMessage, opts: PlanOptions & { lookupTables?: string[] | undefined; tokenFee?: bigint | undefined } = {}): Promise<SolanaPlan> {
    let msg = await this.withLookupTables(input, opts.lookupTables)
    const description = describeTransaction(msg, { account: this.address })
    this.enforce(description, opts)

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
      simulation = await this.simulateGuarded(this.unsignedWire(probe), this.writableAccounts(probe), description)
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
  protected enforceCompiledSigners(description: TransactionDescription, options: PlanOptions = {}): void {
    this.enforce(description, options)
    if (!description.signers.some((s) => s.address === this.address)) throw new UnsafeTransactionError('This wallet is not a required signer of the transaction.')
    const missing = description.signers.filter((s) => s.signed === false && s.address !== this.address).map((s) => s.address)
    if (missing.length) throw new MissingSignersError(missing)
  }

  /** Plan a compiled transaction (kit `Transaction` or base64 wire): hard checks, simulation, fee quote. The bytes are never altered. */
  protected async planCompiled(input: Transaction | string, opts: PlanOptions = {}): Promise<SolanaPlan> {
    const transaction = typeof input === 'string' ? decodeWireTransaction(input) : input
    const description = describeTransaction(transaction, { account: this.address })
    this.enforceCompiledSigners(description, opts)

    let simulation: SimulationResult | undefined
    if (this._rpc !== undefined && (opts.simulate ?? this._config.simulate) !== false) {
      // Accounts behind lookup tables are written too: resolve them so the CPI guard sees every one.
      const tables = resolveCompiledAccounts(transaction).tables
      const lookups = await this.lookupAddresses(tables)
      const layout = resolveCompiledAccounts(transaction, { account: this.address, ...(lookups ? { addressesByLookupTableAddress: lookups } : {}) })
      const written = layout.accounts.filter((a) => isWritableRole(a.role) && a.address !== null).map((a) => a.address as string)
      simulation = await this.simulateGuarded(getBase64EncodedWireTransaction(transaction), written, description)
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
      if (it.kind === 'limit') limit = bigintToNumber(it.value)
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

  /**
   * Raw accounts in the order asked (null where none exists), batched 100 per `getMultipleAccounts`:
   * for modules that check a provider's figures against the chain state they claim to describe.
   */
  async getAccountInfos(addresses: readonly string[]): Promise<Array<SolanaAccountData | null>> {
    const states = await this.accountStates(addresses)
    return addresses.map((a) => { const st = states.get(a); return st ? { owner: st.owner, lamports: st.lamports, data: st.data } : null })
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
  async checkSerialized(base64: string, guard: SerializedTxGuard, options: PlanOptions = {}): Promise<SerializedCheck> {
    assertExpectation(guard?.expect)
    const rpc = this.requireRpc('check provider transactions')
    const transaction = decodeWireTransaction(base64)
    const layout0 = resolveCompiledAccounts(transaction)
    const addressesByLookupTableAddress = await this.lookupAddresses(layout0.tables)
    const ctx = { account: this.address as string, ...(addressesByLookupTableAddress ? { addressesByLookupTableAddress } : {}) }
    const description = describeTransaction(transaction, ctx)
    const layout = resolveCompiledAccounts(transaction, ctx)
    if (layout.unresolved) throw new UnsafeTransactionError('Some accounts come from lookup tables that could not be resolved; the transaction cannot be audited.', 'unresolved-lookup-tables')
    this.enforceCompiledSigners(description, options)

    // 1. Programs.
    if (!guard.allowUnknownPrograms) {
      const allowed = new Set(guard.programAllowlist ?? DEFAULT_PROGRAM_ALLOWLIST)
      const foreign = [...new Set(description.items.map((it) => it.program ?? '<unresolved>').filter((p) => !allowed.has(p)))]
      if (foreign.length) throw new UnsafeTransactionError(`Transaction invokes programs outside the allowlist: ${foreign.join(', ')}.`, 'unknown-program', foreign)
    }
    // 1b. Instructions, when the caller knows the exact shapes its operation takes.
    if (guard.instructions !== undefined) {
      const odd = unexpectedInstruction(layout.compiled, layout.accounts, guard.instructions)
      if (odd) throw new UnsafeTransactionError(`Instruction ${odd.index} (${odd.program}, data ${odd.data || 'empty'}…) is not one this operation takes.`, 'unexpected-instruction', [odd.program])
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
      const safeCore = it.program ? SAFE_CORE_INSTRUCTIONS[it.program] : undefined
      if (it.type === 'program-call' && safeCore && !(it.instruction && safeCore.has(it.instruction))) {
        throw new UnsafeTransactionError(`Transaction runs ${it.instruction ?? 'an undecodable instruction'} on core program ${it.program}.`, 'core-instruction', [it.program])
      }
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
    // The wallet's wrapped-SOL account: aggregators wrap into it and close it afterwards, which also unwraps whatever
    // wSOL the wallet already held. Its lamports are the wallet's SOL, so they are counted with the wallet's own.
    const wsolAta = String(await this.ata(address(WSOL_MINT), this.address, TOKEN_PROGRAM_ADDRESS))
    const writable = layout.accounts.filter((a) => isWritableRole(a.role) && a.address !== null).map((a) => a.address as string)
    const pre = await this.accountStates([this.address, wsolAta, ...tokenInAtas, ...tokenOutAtas, ...writable])
    const ownedTokenAccounts = writable.filter((addr) => {
      const st = pre.get(addr)
      if (!st || !isTokenProgram(st.owner)) return false
      const parsed = parseTokenAccount(st.data)
      return parsed !== null && bytesEqual(parsed.owner, me)
    })
    // Written accounts the transaction may create as token accounts of this wallet (scan 2026-10-28 F3).
    const fresh = this.cpiWatched(writable, pre).filter((a) => !ownedTokenAccounts.includes(a))
    const watched = [...new Set([this.address as string, wsolAta, ...tokenInAtas, ...tokenOutAtas, ...ownedTokenAccounts, ...fresh])]
    // The node returns post-state for at most as many addresses as the transaction has accounts. An address that is
    // not one of them (an ATA of the other token program, say) cannot change: its post-state is its pre-state.
    const inTransaction = new Set(layout.accounts.flatMap((a) => (a.address !== null ? [a.address as string] : [])))
    const simulated = watched.filter((a) => inTransaction.has(a))
    if (simulated.length > MAX_TRANSACTION_ACCOUNTS) throw new UnsafeTransactionError(`Transaction writes ${simulated.length} accounts; the simulation cannot return them all.`, 'too-many-accounts')

    const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction) as never, {
      encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: this._commitment, accounts: { addresses: simulated.map(address), encoding: 'base64' },
    }).send()
    const logs = value.logs ?? []
    if (value.err) throw new SimulationError(describeSimulationErr(value.err), logs)
    const postList = (value as { accounts?: Array<{ lamports: bigint | number; owner: string; data: readonly [string, string] } | null> }).accounts
    if (!postList || postList.length !== simulated.length) throw new NetworkError('simulateTransaction did not return the requested post-state accounts.')
    const post = new Map<string, AccountState | null>()
    for (const addr of watched) post.set(addr, pre.get(addr) ?? null)
    simulated.forEach((addr, i) => { const acc = postList[i]; post.set(addr, acc ? { lamports: BigInt(acc.lamports), owner: acc.owner, data: base64Bytes(acc.data[0]) } : null) })

    const quote = await this.quoteCompiled(transaction, description)
    const lamports = (m: Map<string, { lamports: bigint } | null>, addr: string) => m.get(addr)?.lamports ?? 0n
    const tokenAmount = (m: Map<string, { data: Uint8Array } | null>, addr: string) => { const st = m.get(addr); return st ? (parseTokenAccount(st.data)?.amount ?? 0n) : 0n }
    const tokenDelta = (atas: readonly string[]) => atas.reduce((sum, a) => sum + tokenAmount(post, a) - tokenAmount(pre, a), 0n)

    // Native SOL = the wallet's lamports + every wrapped-SOL token account it owns (before or after): wrapping, unwrapping
    // and closing such an account into the wallet are then neutral, and SOL "received" is real SOL, never the wallet's own
    // wSOL coming back.
    const wsolPk = pubkeyBytes(WSOL_MINT)
    const ownWsol = (st: { owner: string; data: Uint8Array } | null | undefined) => {
      if (!st || !isTokenProgram(st.owner)) return false
      const t = parseTokenAccount(st.data)
      return t !== null && bytesEqual(t.owner, me) && bytesEqual(t.mint, wsolPk)
    }
    const nativeAccounts = watched.filter((addr) => addr !== this.address && (ownWsol(pre.get(addr)) || ownWsol(post.get(addr))))
    const native = (m: Map<string, { lamports: bigint } | null>) => nativeAccounts.reduce((sum, a) => sum + lamports(m, a), lamports(m, this.address))
    const lamportsDelta = native(post) - native(pre)
    const ceiling = expect.maxLamportsOut + quote.fee
    if (lamportsDelta < -ceiling) throw new UnsafeTransactionError(`Transaction spends ${-lamportsDelta} lamports; at most ${ceiling} (${expect.maxLamportsOut} + fee ${quote.fee}) allowed.`, 'lamports-out', [String(-lamportsDelta)])

    let tokenInDelta: bigint | undefined
    if (expect.tokenIn) {
      if (tokenInNative) {
        // Receiving SOL: the net change must cover the minimum after the allowed spend.
        if (lamportsDelta < expect.tokenIn.minAmount - ceiling) throw new UnsafeTransactionError(`Transaction yields ${lamportsDelta} lamports net; at least ${expect.tokenIn.minAmount - ceiling} expected.`, 'slippage', [String(lamportsDelta)])
        if (expect.tokenIn.maxAmount !== undefined && lamportsDelta > expect.tokenIn.maxAmount) throw new UnsafeTransactionError(`Transaction yields ${lamportsDelta} lamports net; at most ${expect.tokenIn.maxAmount} expected.`, 'token-in-excess', [String(lamportsDelta)])
      } else {
        tokenInDelta = tokenDelta(tokenInAtas)
        if (tokenInDelta < expect.tokenIn.minAmount) throw new UnsafeTransactionError(`Transaction delivers ${tokenInDelta} of ${expect.tokenIn.mint}; at least ${expect.tokenIn.minAmount} expected.`, 'slippage', [String(tokenInDelta)])
        if (expect.tokenIn.maxAmount !== undefined && tokenInDelta > expect.tokenIn.maxAmount) throw new UnsafeTransactionError(`Transaction delivers ${tokenInDelta} of ${expect.tokenIn.mint}; at most ${expect.tokenIn.maxAmount} expected.`, 'token-in-excess', [String(tokenInDelta)])
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
    // 4. Ownership and authorities, from the simulated post-state — this also
    //    catches changes made by CPI inside an allowlisted router, which the
    //    top-level decoding above cannot see.
    const walletPre = pre.get(this.address)
    const walletPost = post.get(this.address)
    if (!walletPost || (walletPre && (walletPost.owner !== walletPre.owner || walletPost.data.length !== walletPre.data.length))) {
      throw new UnsafeTransactionError('Transaction changes the owner program or data of this wallet account.', 'wallet-owner', [this.address])
    }
    const approvedSources = new Set(approvals.map((ap) => ap.source))
    for (const addr of simulated) {
      if (addr === this.address) continue
      // A token account the transaction creates counts as this wallet's with no delegate or close authority before (scan 2026-10-28 F3).
      const refusal = await this.cpiAuthorityRefusal(addr, pre.get(addr), post.get(addr), approvedSources.has(addr), '.')
      if (refusal) throw refusal
    }
    const exempt = new Set([...tokenInAtas, ...tokenOutAtas, ...nativeAccounts])
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
  protected async plan(tx: SolanaTransaction, opts: PlanOptions = {}): Promise<SolanaPlan> {
    if (typeof tx === 'string' || isSignedTransaction(tx)) return this.planCompiled(tx, opts)
    return this.planMessage(await this.prepareMessage(tx), { ...opts, lookupTables: isNativeTransfer(tx) ? tx.lookupTables : undefined })
  }

  protected async planTransfer(o: SolanaTransferOptions, opts: PlanOptions = {}): Promise<SolanaPlan> {
    if (o.token) {
      const { message, tokenFee } = await this.buildTokenTransfer(o.token, o.recipient, o.amount)
      return this.planMessage(message, { ...opts, lookupTables: o.lookupTables, tokenFee })
    }
    await this.assertWalletRecipient(o.recipient)
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

  /** Fee breakdown of a transfer, including the compute budget and any Token-2022 transfer fee. */
  async quoteTransfer(o: SolanaTransferOptions): Promise<SolanaFeeQuote> {
    return (await this.planTransfer(o)).quote
  }

  /** Decode without the network: what the transaction does and what to be wary of. */
  describeTransaction(tx: SolanaTransaction): TransactionDescription {
    return describeTransaction(tx, { account: this.address })
  }

  /** The receipt, or `undefined` while the transaction has not landed. */
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


