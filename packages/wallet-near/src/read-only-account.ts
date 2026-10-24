import { NetworkError, type IWalletAccountReadOnly } from '@anywalletkit/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base58ToBytes, bytesToBase58, ed25519Key, isImplicitAccountId, isValidAccountId, publicKeyOfImplicit, publicKeyToString } from './address.js'
import { decodeAnyTransaction, encodeTransaction } from './borsh.js'
import { describeTransaction, isDangerous, type DescribeContext } from './describe.js'
import { SimulationError, UnsafeTransactionError } from './errors.js'
import { NearRpc, createClient, failureOf, fromBase64, outcomeFailed, type RawFinalOutcome } from './rpc.js'
import {
  CAIP2, FT_TRANSFER_GAS, IMPLICIT_ACCOUNT_MIN_DEPOSIT, MAX_GAS, ONE_YOCTO, STORAGE_DEPOSIT_GAS, STORAGE_PRICE_PER_BYTE, TGAS,
  type NearAccountView, type NearAction, type NearBuiltTransaction, type NearConfig, type NearFeeEstimate, type NearFetch, type NearFunctionCallAction,
  type NearPublicKey, type NearQuote, type NearReceipt, type NearSimulation, type NearTransaction, type NearTransferOptions, type NearTxDescription,
} from './types.js'

// ── Gas model (nearcore RuntimeFeesConfig, mainnet; send + exec, non-sir) ────
// Upper bounds: unused prepaid gas is refunded, so a quote is what the signer can
// lose at most, not what it will pay.
const ACTION_RECEIPT_GAS = 2n * 108_059_500_000n
const TRANSFER_GAS = 2n * 115_123_062_500n
const CREATE_ACCOUNT_GAS = 16n * 10n ** 12n // implicit account: create + full-access key + transfer; 15.9 Tgas measured on mainnet
const FUNCTION_CALL_BASE_GAS = 2n * 2_319_861_500_000n
const FUNCTION_CALL_PER_BYTE_GAS = 2n * 2_473_250n
/**
 * Creating an implicit account by transferring to it costs more than its gas:
 * the recipient-side receipt burnt 0.00703 NEAR for 7.5 Tgas on mainnet
 * (tx 3W8EDnjC…, 2026-10-10) — the protocol's account-creation charge. Added
 * on top of the gas estimate whenever a native transfer creates the account.
 */
const IMPLICIT_ACCOUNT_CREATION_COST = 8n * 10n ** 21n // 0.008 NEAR
/** Gas-price can rise 1% per block between quote and execution; keep a margin. */
const GAS_PRICE_MARGIN_NUM = 11n
const GAS_PRICE_MARGIN_DEN = 10n

type FtStorageBalance = { total: string; available: string } | null

/** Default ceiling for a recipient's `storage_deposit` on a token transfer: 0.0125 NEAR. */
export const MAX_STORAGE_DEPOSIT = 12_500_000_000_000_000_000_000n

export class WalletAccountReadOnlyNear implements IWalletAccountReadOnly {
  /** Account id: the implicit hex id of the key, or a named account bound to it. */
  readonly address: string
  readonly chain: string
  readonly publicKey: NearPublicKey
  protected readonly _config: NearConfig
  protected readonly _client: NearFetch | undefined
  protected readonly _rpc: NearRpc | undefined

  /**
   * @param address account id; an implicit (64-hex) id also fixes the public key.
   * @param publicKey required for a named account (the key the account signs with).
   */
  constructor(address: string, config: NearConfig = {}, publicKey?: Uint8Array | NearPublicKey) {
    if (!isValidAccountId(address)) throw new RangeError(`"${address}" is not a valid NEAR account id`)
    this.address = address
    const key = publicKey instanceof Uint8Array ? ed25519Key(publicKey) : publicKey
    if (key) this.publicKey = key
    else if (isImplicitAccountId(address)) this.publicKey = ed25519Key(publicKeyOfImplicit(address))
    else throw new RangeError('A named NEAR account needs its public key.')
    this._config = config
    this._client = createClient(config)
    this._rpc = this._client ? new NearRpc(this._client) : undefined
    const net = config.network ?? 'mainnet'
    this.chain = CAIP2[net] ?? (net.startsWith('near:') ? net : `near:${net}`)
  }

  /** "ed25519:<base58>" */
  get publicKeyString(): string { return publicKeyToString(this.publicKey) }

  protected requireRpc(what: string): NearRpc {
    if (!this._rpc) throw new NetworkError(`The wallet must be connected to a provider to ${what}.`)
    return this._rpc
  }

  async getAddress(): Promise<string> { return this.address }

  /** The account as the node sees it; `undefined` when it does not exist yet. */
  async getAccountView(accountId = this.address): Promise<NearAccountView | undefined> {
    const v = await this.requireRpc('retrieve balances').viewAccount(accountId)
    if (!v) return undefined
    const amount = BigInt(v.amount)
    const locked = BigInt(v.locked)
    const storageUsage = BigInt(v.storage_usage)
    const available = amount - locked - storageUsage * STORAGE_PRICE_PER_BYTE
    return { amount, locked, storageUsage, available: available > 0n ? available : 0n }
  }

  /** Total NEAR balance in yoctoNEAR (0 for an account that does not exist yet). */
  async getBalance(): Promise<bigint> {
    return (await this.getAccountView())?.amount ?? 0n
  }

  /** What can actually be spent: total − locked (staked) − storage reservation. */
  async getAvailableBalance(): Promise<bigint> {
    return (await this.getAccountView())?.available ?? 0n
  }

  async accountExists(accountId: string): Promise<boolean> {
    return (await this.requireRpc('check an account').viewAccount(accountId)) !== undefined
  }

  /** NEP-141 `ft_balance_of`. */
  async getTokenBalance(token: string): Promise<bigint> {
    const r = await this.requireRpc('retrieve token balances').callFunction<string | null>(token, 'ft_balance_of', { account_id: this.address })
    return BigInt(r ?? '0')
  }

  async getTokenBalances(tokens: string[]): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {}
    await Promise.all(tokens.map(async (t) => { out[t] = await this.getTokenBalance(t) }))
    return out
  }

  /** NEP-145 storage registration of `accountId` on a token contract (`null` = not registered). */
  async getStorageBalance(token: string, accountId = this.address): Promise<{ total: bigint; available: bigint } | null> {
    const r = await this.requireRpc('read token storage').callFunction<FtStorageBalance>(token, 'storage_balance_of', { account_id: accountId })
    return r ? { total: BigInt(r.total), available: BigInt(r.available) } : null
  }

  /** Minimum deposit a token contract wants for a registration (`storage_balance_bounds.min`). */
  async getStorageDepositMin(token: string): Promise<bigint> {
    const r = await this.requireRpc('read token storage').callFunction<{ min: unknown; max: unknown } | null>(token, 'storage_balance_bounds', {})
    const min = r?.min ?? '1250000000000000000000'
    if (typeof min !== 'string' || !/^\d{1,40}$/.test(min)) throw new UnsafeTransactionError('storage-deposit', `${token} returned a malformed storage_balance_bounds.min.`)
    return BigInt(min)
  }

  // ── Building ────────────────────────────────────────────────────────────────

  /**
   * The actions for `transfer`: native → one Transfer; NEP-141 → `ft_transfer` (1 yocto, 30 Tgas),
   * preceded by `storage_deposit` when the recipient is not registered on the token.
   */
  async transferActions(o: NearTransferOptions): Promise<{ receiverId: string; actions: NearAction[] }> {
    const amount = BigInt(o.amount)
    if (!isValidAccountId(o.recipient)) throw new UnsafeTransactionError('invalid-account', `"${o.recipient}" is not a valid NEAR account id.`)
    if (!o.token) return { receiverId: o.recipient, actions: [{ transfer: { deposit: amount } }] }
    if (!isValidAccountId(o.token)) throw new UnsafeTransactionError('invalid-account', `"${o.token}" is not a valid token contract id.`)
    const actions: NearAction[] = []
    const registered = await this.getStorageBalance(o.token, o.recipient)
    if (registered === null) {
      const min = await this.getStorageDepositMin(o.token)
      // The token contract names this amount; it rides on our signature, so it is capped.
      const cap = BigInt(this._config.maxStorageDeposit ?? MAX_STORAGE_DEPOSIT)
      if (min > cap) throw new UnsafeTransactionError('storage-deposit', `${o.token} asks ${min} yoctoNEAR to register ${o.recipient}; the cap is ${cap}.`)
      actions.push({ functionCall: { methodName: 'storage_deposit', args: { account_id: o.recipient, registration_only: true }, gas: STORAGE_DEPOSIT_GAS, deposit: min } })
    }
    actions.push({
      functionCall: {
        methodName: 'ft_transfer',
        args: { receiver_id: o.recipient, amount: amount.toString(), ...(o.memo !== undefined ? { memo: o.memo } : {}) },
        gas: FT_TRANSFER_GAS,
        deposit: ONE_YOCTO,
      },
    })
    return { receiverId: o.token, actions }
  }

  /** Fill `signerId` / `publicKey` / `nonce` / `blockHash` (the last two from the node when missing). */
  async buildTransaction(tx: NearTransaction | string): Promise<NearBuiltTransaction> {
    if (typeof tx === 'string') return decodeAnyTransaction(fromBase64(tx)).transaction
    const signerId = tx.signerId ?? this.address
    const publicKey = tx.publicKey ?? this.publicKey
    let nonce = tx.nonce
    let blockHash = typeof tx.blockHash === 'string' ? base58ToBytes(tx.blockHash, 32) : tx.blockHash
    if (nonce === undefined || blockHash === undefined) {
      const rpc = this.requireRpc('build transactions')
      if (nonce === undefined) {
        const key = await rpc.viewAccessKey(signerId, publicKeyToString(publicKey))
        if (!key) throw new UnsafeTransactionError('no-access-key', `${publicKeyToString(publicKey)} is not an access key of ${signerId} (does the account exist and hold NEAR?).`)
        nonce = BigInt(key.nonce) + 1n
      }
      blockHash ??= base58ToBytes(await rpc.latestBlockHash(), 32)
    }
    return { signerId, publicKey, nonce, receiverId: tx.receiverId, blockHash, actions: tx.actions }
  }

  // ── Fees ────────────────────────────────────────────────────────────────────

  /** Gas upper bound for the actions (prepaid function-call gas in full). */
  static gasOf(actions: NearAction[], createsAccount: boolean): bigint {
    let gas = ACTION_RECEIPT_GAS
    for (const a of actions) {
      if ('transfer' in a) gas += TRANSFER_GAS + (createsAccount ? CREATE_ACCOUNT_GAS : 0n)
      else if ('functionCall' in a) {
        const f = (a as NearFunctionCallAction).functionCall
        const argLen = f.args instanceof Uint8Array ? f.args.length : typeof f.args === 'string' ? f.args.length : JSON.stringify(f.args).length
        gas += FUNCTION_CALL_BASE_GAS + FUNCTION_CALL_PER_BYTE_GAS * BigInt(argLen + f.methodName.length) + (f.gas ?? 30n * TGAS)
      } else gas += 5n * TGAS
    }
    return gas
  }

  static depositOf(actions: NearAction[]): bigint {
    let d = 0n
    for (const a of actions) {
      if ('transfer' in a) d += a.transfer.deposit
      else if ('functionCall' in a) d += a.functionCall.deposit ?? 0n
      else if ('stake' in a) d += a.stake.stake
    }
    return d
  }

  protected async estimate(tx: Pick<NearBuiltTransaction, 'receiverId' | 'actions'>, recipientExists?: boolean): Promise<NearFeeEstimate> {
    const rpc = this.requireRpc('estimate fees')
    const isTransfer = tx.actions.some((a) => 'transfer' in a)
    const createsAccount = isTransfer && isImplicitAccountId(tx.receiverId) && !(recipientExists ?? (await this.accountExists(tx.receiverId)))
    const gas = WalletAccountReadOnlyNear.gasOf(tx.actions, createsAccount)
    const gasPrice = ((await rpc.gasPrice()) * GAS_PRICE_MARGIN_NUM) / GAS_PRICE_MARGIN_DEN
    const fee = gas * gasPrice + (createsAccount ? IMPLICIT_ACCOUNT_CREATION_COST : 0n)
    return { gas, gasPrice, fee, deposit: WalletAccountReadOnlyNear.depositOf(tx.actions), createsAccount }
  }

  async estimateFee(tx: NearTransaction | string): Promise<NearFeeEstimate> {
    return this.estimate(typeof tx === 'string' ? await this.buildTransaction(tx) : tx)
  }

  async quoteSendTransaction(tx: NearTransaction | string): Promise<NearQuote> {
    const estimate = await this.estimateFee(tx)
    return { fee: estimate.fee, estimate }
  }

  async quoteTransfer(o: NearTransferOptions): Promise<NearQuote> {
    return this.quoteSendTransaction(await this.transferActions(o))
  }

  // ── Preflight ───────────────────────────────────────────────────────────────

  /**
   * Predict failure without signing: the signer account and its access key exist,
   * the spendable balance covers deposits + fee, a named recipient exists (an
   * implicit one may be created, for ≥ 0.002 NEAR), the token balance covers an
   * `ft_transfer`. Transport failures throw; predicted failures don't.
   */
  async simulateTransaction(tx: NearBuiltTransaction | NearTransaction, estimate?: NearFeeEstimate): Promise<NearSimulation> {
    const rpc = this.requireRpc('simulate transactions')
    const signerId = tx.signerId ?? this.address
    const d = describeTransaction(tx, { signerId })
    const acct = await this.getAccountView(signerId)
    if (!acct) return { ok: false, reason: `Account ${signerId} does not exist (fund it with NEAR first).` }
    const key = await rpc.viewAccessKey(signerId, publicKeyToString(tx.publicKey ?? this.publicKey))
    if (!key) return { ok: false, reason: `${publicKeyToString(tx.publicKey ?? this.publicKey)} is not an access key of ${signerId}.` }
    if (key.permission !== 'FullAccess') {
      const p = key.permission.FunctionCall
      if (p.receiver_id !== tx.receiverId || d.deposit > 0n) return { ok: false, reason: `The access key may only call ${p.receiver_id} without a deposit.` }
      if (p.method_names.length && d.methods?.some((m) => !p.method_names.includes(m))) return { ok: false, reason: 'The access key does not allow this method.' }
    }
    let recipientExists: boolean | undefined
    if (d.kind === 'near-transfer') {
      recipientExists = await this.accountExists(tx.receiverId)
      if (!recipientExists) {
        if (!isImplicitAccountId(tx.receiverId)) return { ok: false, reason: `Account ${tx.receiverId} does not exist.` }
        if ((d.amount ?? 0n) < IMPLICIT_ACCOUNT_MIN_DEPOSIT) return { ok: false, reason: `Creating ${tx.receiverId} needs at least 0.002 NEAR.` }
      }
    } else if (!(await this.accountExists(tx.receiverId))) {
      return { ok: false, reason: `Contract ${tx.receiverId} does not exist.` }
    }
    const est = estimate ?? (await this.estimate(tx, recipientExists))
    const need = est.deposit + est.fee
    if (acct.available < need) return { ok: false, reason: `Insufficient NEAR: need ${need} yocto (deposit + fee), spendable ${acct.available}.` }
    if (d.kind === 'ft-transfer' && d.token && d.amount !== undefined) {
      const bal = await this.getTokenBalance(d.token)
      if (bal < d.amount) return { ok: false, reason: `Insufficient ${d.token}: need ${d.amount}, have ${bal}.` }
      if (d.to && (await this.getStorageBalance(d.token, d.to)) === null && !d.methods?.includes('storage_deposit')) {
        return { ok: false, reason: `${d.to} is not registered on ${d.token}; add a storage_deposit action first.` }
      }
    }
    return { ok: true }
  }

  // ── Hard checks ─────────────────────────────────────────────────────────────

  /**
   * Refuse what cannot be right: a foreign signer or key, no actions, a dangerous
   * action (unless `allowDangerousActions`), an invalid receiver, prepaid gas over
   * 300 Tgas, a fee above `transactionMaxFee`.
   */
  assertSafe(tx: NearBuiltTransaction, fee?: bigint): void {
    if (tx.signerId !== this.address) throw new UnsafeTransactionError('signer-mismatch', `Transaction signer ${tx.signerId} is not this account (${this.address}).`)
    if (tx.publicKey.keyType !== this.publicKey.keyType || !equalBytes(tx.publicKey.data, this.publicKey.data)) throw new UnsafeTransactionError('public-key-mismatch', 'The transaction public key is not this account\'s key.')
    if (!tx.actions.length) throw new UnsafeTransactionError('no-actions', 'The transaction has no actions.')
    if (!isValidAccountId(tx.receiverId)) throw new UnsafeTransactionError('invalid-account', `"${tx.receiverId}" is not a valid NEAR account id.`)
    if (tx.blockHash.length !== 32) throw new UnsafeTransactionError('missing-block-hash', 'The transaction has no 32-byte block hash.')
    if (tx.nonce <= 0n) throw new UnsafeTransactionError('missing-nonce', 'The transaction nonce must be positive.')
    if (!this._config.allowDangerousActions) {
      const bad = tx.actions.find(isDangerous)
      if (bad) throw new UnsafeTransactionError('dangerous-action', `Refusing ${Object.keys(bad)[0]}: it changes the account, its keys or its code (set allowDangerousActions to override).`)
    }
    let gas = 0n
    for (const a of tx.actions) if ('functionCall' in a) gas += a.functionCall.gas ?? 30n * TGAS
    if (gas > MAX_GAS) throw new UnsafeTransactionError('gas-limit', `Prepaid gas ${gas} exceeds the 300 Tgas limit.`)
    const max = this._config.transactionMaxFee
    if (fee !== undefined && max !== undefined && fee > BigInt(max)) throw new UnsafeTransactionError('fee-limit', `Fee ${fee} exceeds transactionMaxFee ${max}.`)
  }

  // ── Describe / receipts / verify ────────────────────────────────────────────

  /** `describeTransaction` plus the recipient-existence check against the node. */
  async describeTransactionOnline(tx: NearTransaction, ctx: DescribeContext = {}): Promise<NearTxDescription> {
    const offline = describeTransaction(tx, { signerId: this.address, ...ctx })
    if (ctx.recipientExists !== undefined || offline.kind !== 'near-transfer') return offline
    return describeTransaction(tx, { signerId: this.address, ...ctx, recipientExists: await this.accountExists(tx.receiverId) })
  }

  /** Status of one of this account's transactions (the `tx` RPC needs the sender). */
  async getTransactionReceipt(hash: string): Promise<NearReceipt | undefined> {
    const o = await this.requireRpc('fetch transaction receipts').txStatus(hash, this.address)
    if (!o) return undefined
    return receiptOf(hash, o)
  }

  /** Verify an `ed25519:<base58>` (or bare base58 / hex) signature produced by `sign`. */
  async verify(message: string | Uint8Array, signature: string): Promise<boolean> {
    try {
      const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
      return ed25519.verify(parseSignature(signature), bytes, this.publicKey.data)
    } catch { return false }
  }

  /** sha256(borsh(tx)) — what gets signed; base58 of it is the transaction hash. */
  static hashOf(tx: NearBuiltTransaction): Uint8Array { return sha256(encodeTransaction(tx)) }
  static txHash(tx: NearBuiltTransaction): string { return bytesToBase58(WalletAccountReadOnlyNear.hashOf(tx)) }
}

export function receiptOf(hash: string, o: RawFinalOutcome): NearReceipt {
  const failure = outcomeFailed(o)
  const pending = o.final_execution_status !== undefined && /NONE|INCLUDED$/.test(o.final_execution_status) && !failureOf(o.status) && o.status === undefined
  return { hash, status: failure ? 0 : 1, ...(failure ? { failure } : {}), raw: { ...o, ...(pending ? { pending: true } : {}) } }
}

export function parseSignature(signature: string): Uint8Array {
  const s = signature.startsWith('ed25519:') ? signature.slice('ed25519:'.length) : signature
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(s)) {
    const hex = s.replace(/^0x/, '')
    return Uint8Array.from(hex.match(/.{2}/g)!, (b) => parseInt(b, 16))
  }
  return base58ToBytes(s, 64)
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
