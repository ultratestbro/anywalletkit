import { LocalSigner, feeLimit, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult, type WriteOptions } from '@anywalletkit/core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  BaseError, ContractFunctionRevertedError, getAddress, hashMessage, hashTypedData, hexToBytes, keccak256, serializeTransaction, TransactionNotFoundError, zeroAddress,
  type Hex, type PublicClient, type Signature, type TransactionSerializable,
} from 'viem'
import { publicKeyToAddress } from 'viem/accounts'
import { encodeApprove, ERC20_PERMIT_ABI, PERMIT_TYPES, USDT_MAINNET } from './erc20.js'

/** ERC-165 interface id of ERC-721. */
const ERC721_INTERFACE = '80ac58cd'
import { BroadcastUnknownError, ChainMismatchError, PermitUnsupportedError, SimulationError, UnsafeTransactionError } from './errors.js'
import { WalletAccountReadOnlyEvm, assertTxShape, canonicalData, chainIdNumber, transferTransaction, typedDataHash, typedDomainChainId } from './read-only-account.js'
export { MIN_PRIORITY_FEE_WEI, typedDomainChainId } from './read-only-account.js'
import type { ApproveOptions, EvmConfig, EvmTransaction, EvmTransferOptions, PermitInfo, PermitOptions, SignedPermit, TypedDataInput } from './types.js'

const toHex = (u8: Uint8Array): Hex => `0x${Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')}`

/** Uncompressed 65-byte public key → checksummed address. */
export function addressFromPublicKey(compressed: Uint8Array): `0x${string}` {
  const uncompressed = secp256k1.Point.fromHex(toHex(compressed).slice(2)).toBytes(false)
  return publicKeyToAddress(toHex(uncompressed))
}

function toBigInt(v: bigint | number | string | undefined): bigint | undefined {
  return v === undefined ? undefined : BigInt(v)
}

/**
 * The signing EVM account. It never holds a key: every signature is a
 * `signer.sign(hash, {scheme: 'ecdsa-recoverable', context})` call over a
 * viem-computed hash — a {@link LocalSigner} for seed wallets, anything else
 * (hardware, Safe, MPC, backend) through `externalSigner()`.
 */
/** How long a self-observed next nonce outranks the network's `pending` answer. */
export const NONCE_FLOOR_TTL_MS = 90_000
/** Simulation re-runs (and the pause between them) when a revert follows the account's own broadcast. */
export const SIMULATION_SETTLE_RETRIES = 3
export const SIMULATION_SETTLE_DELAY_MS = 1_500
/**
 * The nonce was taken: by a transaction the RPC's stale `pending` count did not show, or by this
 * very transaction after a lost answer. `replacement transaction underpriced` is NOT here: another
 * transaction of ours holds the nonce in the pool, and signing a new one beside it pays twice.
 */
const NONCE_TOO_LOW = /nonce too low|nonce is too low|invalid nonce/i
/** The node already holds these exact bytes (geth / erigon, besu, nethermind, openethereum wording). */
const ALREADY_KNOWN = /already ?known|\bknown transaction|already imported/i
const errorText = (e: unknown): string => {
  const parts: string[] = []
  for (let cur: unknown = e; cur && parts.length < 6; cur = (cur as { cause?: unknown }).cause) {
    const o = cur as { message?: unknown; details?: unknown; shortMessage?: unknown }
    for (const v of [o.message, o.details, o.shortMessage]) if (typeof v === 'string') parts.push(v)
  }
  return parts.join('\n')
}
/** A node's own refusal (nothing entered the mempool), as opposed to a lost answer. */
const NODE_REJECTION = /\bnonce\b|underpriced|insufficient funds|intrinsic gas|exceeds block gas limit|fee cap|\btip\b|invalid (?:sender|signature|transaction)|already known|transaction (?:type )?not supported/i
const nodeAnswered = (e: unknown): boolean => {
  if (NODE_REJECTION.test(errorText(e))) return true
  // A JSON-RPC error object came back (viem maps an unexplained throw to code -1).
  for (let cur: unknown = e, i = 0; cur && i < 6; cur = (cur as { cause?: unknown }).cause, i++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'number' && code !== -1) return true
  }
  return false
}

/** Worst-case fee of a prepared transaction: all its gas at its cap (`gasPrice`, or `maxFeePerGas`). */
export function maxFeeCost(tx: TransactionSerializable): bigint {
  const rate = tx.type === 'legacy' || tx.type === 'eip2930' ? tx.gasPrice : tx.maxFeePerGas
  if (tx.gas === undefined || rate === undefined) throw new Error('Cannot bound the fee of a transaction without gas and a fee cap.')
  return tx.gas * rate
}


/**
 * An EVM account with a signer: signs messages, typed data, permits and transactions, and sends
 * transfers and approvals. Before signing it checks the chain id and simulates the transaction
 * (when a provider is configured), and refuses value sent to the zero address.
 */
export class WalletAccountEvm extends WalletAccountReadOnlyEvm implements IWalletAccount {
  readonly needsNetwork = false
  /** Derivation path, or `external` for an external signer. */
  readonly path: string
  /** Compressed secp256k1 public key (33 bytes). */
  readonly publicKey: Uint8Array
  /** The signer that holds the key. */
  readonly signer: Signer
  private _readOnly: WalletAccountReadOnlyEvm | undefined
  /**
   * Next nonce this account expects after its own last broadcast, trusted for
   * {@link NONCE_FLOOR_TTL_MS}. Public RPCs sit behind load balancers whose
   * backends lag each other by a block: on Base (2026-10-09) `pending` came
   * back one too low right after our approval was mined, and the swap that
   * followed was rejected by every node with "nonce too low". The floor only
   * ever raises the network's answer, and it expires so a dropped transaction
   * cannot leave the account stuck on a future nonce.
   */
  private _nonceFloor: { next: number; at: number } | undefined
  /** Tail of this account's send queue: prepare → sign → submit runs one send at a time. */
  private _sendTail: Promise<unknown> = Promise.resolve()

  /** `publicKey` is the signer's compressed secp256k1 key (33 bytes); it is needed synchronously for the address. */
  constructor(signer: Signer, publicKey: Uint8Array, path: string, config: EvmConfig = {}) {
    super(addressFromPublicKey(publicKey), config)
    this.signer = requireCurve(signer, 'secp256k1')
    this.publicKey = publicKey
    this.path = path
  }

  /** Back-compat: wrap a raw derived key in a {@link LocalSigner} (the account takes ownership; it cannot derive). */
  static fromPrivateKey(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: EvmConfig = {}): WalletAccountEvm {
    return new WalletAccountEvm(LocalSigner.fromPrivateKey('secp256k1', privateKey, publicKey, path), publicKey, path, config)
  }

  /** Account index when the path is the standard m/44'/60'/0'/0/i, else undefined. */
  get index(): number | undefined {
    const m = /^m\/44'\/60'\/0'\/0\/(\d+)$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  /** Recoverable secp256k1 signature over a 32-byte hash from the signer, as a viem Signature (v = 27 | 28). */
  async #signHash(hash: Hex, context: 'evm-tx' | 'evm-191' | 'evm-712'): Promise<Signature> {
    const sig = await this.signer.sign(hexToBytes(hash), { scheme: 'ecdsa-recoverable', context })
    const recovery = sig[64]!
    const r = toHex(sig.slice(0, 32))
    const s = toHex(sig.slice(32, 64))
    return { r, s, v: BigInt(27 + recovery), yParity: recovery }
  }

  private serializeSignature(sig: Signature): Hex {
    return `0x${sig.r.slice(2)}${sig.s.slice(2)}${sig.v!.toString(16)}`
  }

  /** EIP-191 personal_sign; returns 65-byte hex with v ∈ {27, 28} (ethers encoding). */
  async sign(message: string | Uint8Array): Promise<string> {
    const hash = hashMessage(typeof message === 'string' ? message : { raw: message })
    return this.serializeSignature(await this.#signHash(hash, 'evm-191'))
  }

  /** The account's chain when it is known without a network round-trip (config, detected earlier, or the tx itself). */
  private knownChainId(): number | undefined {
    const c = this.chain
    return c === 'eip155:unknown' ? undefined : Number(c.slice('eip155:'.length))
  }

  /**
   * The chain to check a payload against: known already, else detected from the
   * provider (a dApp-chosen chain id must not be signed just because detection
   * has not run yet). Undefined only for an offline wallet with no `chainId`.
   */
  private async chainForChecks(): Promise<number | undefined> {
    const known = this.knownChainId()
    if (known !== undefined || !this._client) return known
    return this.getChainId()
  }

  /** Refusals before signing: wrong chain, value to the zero address. */
  private async assertSafeTransaction(tx: EvmTransaction): Promise<void> {
    const known = await this.chainForChecks()
    const asked = tx.chainId !== undefined ? chainIdNumber(tx.chainId) : undefined
    if (asked !== undefined && known !== undefined && asked !== known) throw new ChainMismatchError(known, asked)
    const value = toBigInt(tx.value) ?? 0n
    if (tx.to !== undefined && getAddress(tx.to) === zeroAddress && value > 0n && !this._config.allowBurn) {
      throw new UnsafeTransactionError('Refusing to send value to the zero address (set allowBurn to override).')
    }
  }

  private async assertSafeTypedData(typed: TypedDataInput): Promise<void> {
    const known = await this.chainForChecks()
    const domainChain = typedDomainChainId(typed.domain.chainId)
    if (domainChain !== undefined && known !== undefined && domainChain !== known && !this._config.allowCrossChainTypedData) {
      throw new ChainMismatchError(known, domainChain, 'typed data')
    }
  }

  /** EIP-712. Accepts `{domain, types, message}`; `primaryType` is inferred when absent. */
  async signTypedData(typed: TypedDataInput): Promise<string> {
    await this.assertSafeTypedData(typed)
    return this.serializeSignature(await this.#signHash(typedDataHash(typed), 'evm-712'))
  }

  /** ethers-shaped tx → viem serializable, filling gaps from the network when there is a client. */
  private async prepare(tx: EvmTransaction): Promise<TransactionSerializable> {
    assertTxShape(tx)
    const chainId = tx.chainId !== undefined ? chainIdNumber(tx.chainId) : await this.getChainId()
    const nonce = tx.nonce ?? (await this.nextNonce())
    const to = tx.to !== undefined ? getAddress(tx.to) : undefined
    const value = toBigInt(tx.value) ?? 0n
    const data = canonicalData(tx.data) ?? '0x'
    const gas = await this.gasFor(tx)

    const base = { chainId, nonce, ...(to ? { to } : {}), value, data, gas }
    const fees = await this.feeFields(tx, chainId)
    if ('gasPrice' in fees && tx.type === 4) throw new Error('An EIP-7702 (type 4) transaction takes EIP-1559 fee fields, and this chain answered with a legacy gas price.')
    if ('gasPrice' in fees) {
      return tx.type === 1
        ? { ...base, type: 'eip2930', gasPrice: fees.gasPrice, accessList: tx.accessList ?? [] }
        : { ...base, type: 'legacy', gasPrice: fees.gasPrice }
    }
    if (tx.type === 4) {
      return { ...base, type: 'eip7702', ...fees, accessList: tx.accessList ?? [], authorizationList: (tx.authorizationList ?? []) as never }
    }
    return { ...base, type: 'eip1559', ...fees, accessList: tx.accessList ?? [] }
  }

  /**
   * The fee cap, checked on the transaction about to be SIGNED: its gas limit × its own
   * `gasPrice` / `maxFeePerGas`, whoever set them. A network quote is not enough — a caller's
   * fee fields are signed as given. Returns that worst-case fee.
   */
  private capFee(prepared: TransactionSerializable, limit: bigint | number | undefined, op: string): bigint {
    const fee = maxFeeCost(prepared)
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
    return fee
  }

  /**
   * The checks before a send prepares the transaction, in order: static refusals,
   * simulation (unless `simulate: false`), gas (taken from the simulation so
   * `estimateGas` runs once). Returns the tx with `gasLimit` filled; the fee cap
   * and the balance are checked on the prepared transaction.
   */
  private async preflight(tx: EvmTransaction): Promise<EvmTransaction> {
    await this.getChainId() // network path: know the chain so a foreign tx.chainId is refused, not broadcast
    await this.assertSafeTransaction(tx)
    let gasLimit = toBigInt(tx.gasLimit)
    let estimated: bigint | undefined
    if (this._config.simulate !== false) {
      let sim = await this.simulateTransaction(tx)
      // A revert right behind this account's OWN broadcast is, far more often
      // than not, a load-balanced RPC backend that has not seen that block yet
      // (Base, 2026-10-09: approval mined, the swap's transferFrom simulated
      // against allowance 0). Give the network a few seconds before refusing;
      // a genuine revert still fails, just later. Cold sends are not retried.
      for (let attempt = 0; !sim.ok && this.recentlyBroadcast() && attempt < SIMULATION_SETTLE_RETRIES; attempt++) {
        await new Promise((r) => setTimeout(r, SIMULATION_SETTLE_DELAY_MS))
        sim = await this.simulateTransaction(tx)
      }
      if (!sim.ok) throw new SimulationError(sim.reason, sim.data)
      estimated = sim.gas
    }
    // A caller-supplied limit is used as is; an estimate gets headroom (default
    // ×1.2) — estimateGas is a lower bound and state can move before inclusion.
    if (gasLimit === undefined) {
      estimated ??= await this.gasFor(tx)
      const pct = BigInt(Math.round((this._config.gasHeadroom ?? 1.2) * 100))
      gasLimit = (estimated * pct + 99n) / 100n
    }
    return { ...tx, gasLimit }
  }

  /**
   * The node only tells us at broadcast ("insufficient funds for gas * price
   * + value") — by then an ERC-20 approval may already be mined and paid for
   * (Arbitrum, 2026-10-10). Refuse here, before anything is signed.
   */
  private async assertCanPay(fee: bigint, value: bigint, op: string): Promise<void> {
    const need = fee + value
    const balance = await this.getBalance()
    if (balance < need) throw new UnsafeTransactionError(`Insufficient native balance for ${op}: need ${need} wei (fee ${fee} + value ${value}), have ${balance}.`)
  }

  /**
   * Sign WITHOUT broadcasting. Fully-specified EIP-1559 / legacy txs sign
   * offline; the chain and zero-address refusals still apply. Simulation is
   * NOT run here (nothing is sent) — `sendTransaction` runs it.
   */
  async signTransaction(tx: EvmTransaction, options: WriteOptions = {}): Promise<string> {
    await this.assertSafeTransaction(tx)
    const prepared = await this.prepare(tx)
    this.capFee(prepared, feeLimit(this._config.transactionMaxFee, options), 'transaction')
    const hash = keccak256(serializeTransaction(prepared))
    return serializeTransaction(prepared, await this.#signHash(hash, 'evm-tx'))
  }

  private recentlyBroadcast(): boolean {
    return this._nonceFloor !== undefined && Date.now() - this._nonceFloor.at < NONCE_FLOOR_TTL_MS
  }

  private async nextNonce(): Promise<number> {
    const pending = await this.requireClient('fetch the nonce').getTransactionCount({ address: this.address, blockTag: 'pending' })
    const floor = this._nonceFloor
    if (floor && Date.now() - floor.at < NONCE_FLOOR_TTL_MS) return Math.max(pending, floor.next)
    return pending
  }

  /** Sign a prepared transaction; the fee cap is checked again before every signature. */
  async #signPrepared(prepared: TransactionSerializable, limit: bigint | number | undefined, op: string): Promise<{ raw: Hex; hash: Hex; nonce: number }> {
    this.capFee(prepared, limit, op)
    const raw = serializeTransaction(prepared, await this.#signHash(keccak256(serializeTransaction(prepared)), 'evm-tx'))
    return { raw, hash: keccak256(raw), nonce: prepared.nonce! }
  }

  /**
   * Is `hash` on the network (pool or chain)? A failed lookup is not a "no": the transaction may
   * hold the nonce, so the send ends as {@link BroadcastUnknownError} instead of a second signature.
   */
  private async isOnNetwork(client: PublicClient, hash: Hex, cause: unknown): Promise<boolean> {
    try {
      await client.getTransaction({ hash })
      return true
    } catch (e) {
      if (e instanceof TransactionNotFoundError) return false
      throw new BroadcastUnknownError(hash, cause)
    }
  }

  /**
   * One send at a time per account: two sends started together would both read the same `pending`
   * nonce before either is broadcast, and the second would replace (or be refused for) the first.
   * A failed send does not block the next.
   */
  #signAndBroadcast(tx: EvmTransaction, limit: bigint | number | undefined, op: string): Promise<TransferResult> {
    const run = this._sendTail.then(() => this.#signAndBroadcastNow(tx, limit, op))
    this._sendTail = run.then(() => undefined, () => undefined)
    return run
  }

  async #signAndBroadcastNow(tx: EvmTransaction, limit: bigint | number | undefined, op: string): Promise<TransferResult> {
    const client = this.requireClient(op === 'transfer' ? 'transfer tokens' : 'send transactions')
    const checked = await this.preflight(tx)
    const prepared = await this.prepare(checked)
    const fee = this.capFee(prepared, limit, op)
    await this.assertCanPay(fee, prepared.value ?? 0n, op)
    const accepted = (hash: Hex, nonce: number): TransferResult => {
      this._nonceFloor = { next: nonce + 1, at: Date.now() }
      return { hash, fee }
    }
    const submit = async (signed: { raw: Hex; hash: Hex; nonce: number }): Promise<TransferResult> => {
      try {
        return accepted(await client.sendRawTransaction({ serializedTransaction: signed.raw }), signed.nonce)
      } catch (error) {
        // These exact bytes are in a pool already: an earlier attempt reached a
        // node and its answer was lost (viem's fallback then hands the same
        // bytes to the next RPC). It is the same transaction — never sign another.
        if (ALREADY_KNOWN.test(errorText(error))) return accepted(signed.hash, signed.nonce)
        // No answer from the node: the tx may be in the mempool under this hash.
        if (!nodeAnswered(error)) throw new BroadcastUnknownError(signed.hash, error)
        throw error
      }
    }
    const first = await this.#signPrepared(prepared, limit, op)
    try {
      return await submit(first)
    } catch (error) {
      // A nonce the caller fixed is theirs to retry; an unknown outcome is never re-signed.
      if (checked.nonce !== undefined || error instanceof BroadcastUnknownError || !NONCE_TOO_LOW.test(errorText(error))) throw error
      // "nonce too low" right after a lost answer can be THIS transaction,
      // mined in between: look for its hash before signing anything new.
      if (await this.isOnNetwork(client, first.hash, error)) return accepted(first.hash, first.nonce)
      // Not ours: the RPC's `pending` count was stale. The node that rejected
      // us knows the real next nonce, and nothing of ours holds this one, so
      // one re-sign of the same payload is safe.
      const hinted = /next nonce (\d+)/i.exec(errorText(error))
      this._nonceFloor = { next: Math.max(first.nonce + 1, hinted ? Number(hinted[1]) : 0), at: Date.now() }
      return submit(await this.#signPrepared({ ...prepared, nonce: await this.nextNonce() }, limit, op))
    }
  }

  /** Sign and broadcast; `options.maxFee` caps the signed fee on top of `transactionMaxFee`. */
  async sendTransaction(tx: EvmTransaction, options: WriteOptions = {}): Promise<TransferResult> {
    return this.#signAndBroadcast(tx, feeLimit(this._config.transactionMaxFee, options), 'transaction')
  }

  async transfer(options: EvmTransferOptions, writeOptions: WriteOptions = {}): Promise<TransferResult> {
    return this.#signAndBroadcast(transferTransaction(options), feeLimit(this._config.transferMaxFee, writeOptions), 'transfer')
  }

  // ── EIP-2612 permit ────────────────────────────────────────────────────────

  /**
   * Does `token` implement EIP-2612 permit, and with which domain? Supported
   * only when the domain separator we rebuild from name/version/chainId/
   * verifyingContract equals the contract's own — so a signature we produce
   * is one the contract will accept. DAI's legacy `permit(holder, spender,
   * nonce, expiry, allowed)` is NOT recognised.
   */
  async getPermitInfo(token: string): Promise<PermitInfo> {
    const client = this.requireClient('read permit data')
    const address = getAddress(token)
    const read = <T,>(functionName: 'name' | 'version' | 'nonces' | 'DOMAIN_SEPARATOR', args: unknown[] = []) =>
      client.readContract({ address, abi: ERC20_PERMIT_ABI, functionName, args } as never) as Promise<T>
    let nonce: bigint
    let onChain: Hex
    let name: string
    try {
      ;[nonce, onChain, name] = await Promise.all([read<bigint>('nonces', [this.address]), read<Hex>('DOMAIN_SEPARATOR'), read<string>('name')])
    } catch (e) {
      return { supported: false, reason: e instanceof Error ? e.message.split('\n')[0]! : 'nonces()/DOMAIN_SEPARATOR()/name() unavailable' }
    }
    const chainId = await this.getChainId()
    const declared = await read<string>('version').catch(() => undefined)
    const candidates = [...new Set([declared, '1', '2'].filter((v): v is string => typeof v === 'string'))]
    for (const version of candidates) {
      const separator = hashTypedData({
        domain: { name, version, chainId, verifyingContract: address },
        types: { EIP712Domain: [] },
        primaryType: 'EIP712Domain',
        message: {},
      } as never)
      if (separator.toLowerCase() === onChain.toLowerCase()) return { supported: true, name, version, nonce, domainSeparator: onChain, chainId }
    }
    return { supported: false, reason: 'the EIP-712 domain could not be reproduced from name()/version() — non-standard permit domain' }
  }

  /** Sign an EIP-2612 permit for `spender`. Nothing is broadcast; the spender submits it. */
  async signPermit(options: PermitOptions): Promise<SignedPermit> {
    const info = await this.getPermitInfo(options.token)
    if (!info.supported) throw new PermitUnsupportedError(options.token, info.reason)
    const deadline = BigInt(options.deadline)
    const typedData: TypedDataInput = {
      domain: { name: info.name, version: info.version, chainId: info.chainId, verifyingContract: getAddress(options.token) },
      types: { Permit: [...PERMIT_TYPES.Permit] },
      primaryType: 'Permit',
      message: { owner: this.address, spender: getAddress(options.spender), value: BigInt(options.value), nonce: info.nonce, deadline },
    }
    const signature = (await this.signTypedData(typedData)) as Hex
    return {
      signature,
      r: `0x${signature.slice(2, 66)}`,
      s: `0x${signature.slice(66, 130)}`,
      v: Number.parseInt(signature.slice(130, 132), 16),
      nonce: info.nonce,
      deadline,
      typedData,
    }
  }

  /**
   * ERC-20 approve. Mainnet USDT non-zero → non-zero is refused or auto-reset (`autoResetAllowance`).
   * `writeOptions.maxFee` (and `transactionMaxFee`) holds for each transaction signed, the reset too.
   */
  async approve(options: ApproveOptions, writeOptions: WriteOptions = {}): Promise<TransferResult> {
    const client = this.requireClient('approve funds')
    const token = getAddress(options.token)
    const spender = getAddress(options.spender)
    const amount = BigInt(options.amount)
    await this.#assertErc20(client, token)
    if (amount > 0n && (await this.getChainId()) === 1 && token.toLowerCase() === USDT_MAINNET) {
      const current = await this.getAllowance(token, spender)
      if (current > 0n) {
        if (!this._config.autoResetAllowance) {
          throw new Error('USDT requires the current allowance to be reset to 0 before setting a new non-zero value. Please send an "approve" transaction with an amount of 0 first.')
        }
        const reset = await this.sendTransaction({ to: token, value: 0n, data: encodeApprove(spender, 0n) }, writeOptions)
        await client.waitForTransactionReceipt({ hash: reset.hash as Hex })
      }
    }
    return this.sendTransaction({ to: token, value: 0n, data: encodeApprove(spender, amount) }, writeOptions)
  }

  /**
   * `approve` is the ERC-20 allowance call: on an ERC-721, approve(spender, n) approves token #n, so
   * approve({ amount: 0 }) would grant token #0 while reading as a revoke (scan 2026-10-27 F23). A
   * token that reports ERC-721 through ERC-165, or has no decimals(), is refused.
   */
  async #assertErc20(client: PublicClient, token: Hex): Promise<void> {
    const read = async (data: Hex): Promise<Hex | undefined> => {
      try {
        return (await client.call({ to: token, data })).data
      } catch (e) {
        if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError || /revert/i.test((x as Error).message ?? ''))) return undefined
        throw e
      }
    }
    const [erc721, decimals] = await Promise.all([read(`0x01ffc9a7${ERC721_INTERFACE.padEnd(64, '0')}`), read('0x313ce567')])
    if (erc721 !== undefined && /^0x0{63}1$/.test(erc721.slice(0, 66))) throw new UnsafeTransactionError(`${token} is an ERC-721: approve() is for ERC-20 tokens (on an NFT it would approve a token id).`)
    if (decimals === undefined || decimals.length < 66) throw new UnsafeTransactionError(`${token} has no decimals(), so it is not an ERC-20 token approve() can be used on.`)
  }

  /** The same address as a {@link WalletAccountReadOnlyEvm}. */
  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyEvm(this.address, this._config)
    return this._readOnly
  }

  /** Dispose the signer (zeroizes a local key). Idempotent. */
  dispose(): void {
    this.signer.dispose()
  }
}

export { ReadOnlyAccountError } from '@anywalletkit/core'
