import { LocalSigner, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult } from '@forgewallet/core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  getAddress, hashMessage, hashTypedData, hexToBytes, keccak256, serializeTransaction, zeroAddress,
  type Hex, type Signature, type TransactionSerializable,
} from 'viem'
import { publicKeyToAddress } from 'viem/accounts'
import { encodeApprove, ERC20_PERMIT_ABI, PERMIT_TYPES, USDT_MAINNET } from './erc20.js'
import { ChainMismatchError, PermitUnsupportedError, SimulationError, UnsafeTransactionError } from './errors.js'
import { WalletAccountReadOnlyEvm, cleanTypes, inferPrimaryType, transferTransaction } from './read-only-account.js'
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
const NONCE_TOO_LOW = /nonce too low|nonce is too low|invalid nonce|replacement transaction underpriced|already known/i
const errorText = (e: unknown): string => {
  const parts: string[] = []
  for (let cur: unknown = e; cur && parts.length < 6; cur = (cur as { cause?: unknown }).cause) {
    const o = cur as { message?: unknown; details?: unknown; shortMessage?: unknown }
    for (const v of [o.message, o.details, o.shortMessage]) if (typeof v === 'string') parts.push(v)
  }
  return parts.join('\n')
}

export class WalletAccountEvm extends WalletAccountReadOnlyEvm implements IWalletAccount {
  readonly needsNetwork = false
  readonly path: string
  readonly publicKey: Uint8Array
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
  private async signHash(hash: Hex, context: 'evm-tx' | 'evm-191' | 'evm-712'): Promise<Signature> {
    const sig = await this.signer.sign(hexToBytes(hash), { scheme: 'ecdsa-recoverable', context })
    const recovery = sig[64]!
    const r = toHex(sig.slice(0, 32))
    const s = toHex(sig.slice(32, 64))
    return { r, s, v: BigInt(27 + recovery), yParity: recovery }
  }

  private serializeSignature(sig: Signature): Hex {
    return `0x${sig.r.slice(2)}${sig.s.slice(2)}${Number(sig.v).toString(16)}`
  }

  /** EIP-191 personal_sign; returns 65-byte hex with v ∈ {27, 28} (ethers encoding). */
  async sign(message: string | Uint8Array): Promise<string> {
    const hash = hashMessage(typeof message === 'string' ? message : { raw: message })
    return this.serializeSignature(await this.signHash(hash, 'evm-191'))
  }

  /** The account's chain when it is known without a network round-trip (config, detected earlier, or the tx itself). */
  private knownChainId(): number | undefined {
    const c = this.chain
    return c === 'eip155:unknown' ? undefined : Number(c.slice('eip155:'.length))
  }

  /** Refusals that need no network: wrong chain, value to the zero address. */
  private assertSafeTransaction(tx: EvmTransaction): void {
    const known = this.knownChainId()
    if (tx.chainId !== undefined && known !== undefined && Number(tx.chainId) !== known) {
      throw new ChainMismatchError(known, Number(tx.chainId))
    }
    const value = toBigInt(tx.value) ?? 0n
    if (tx.to !== undefined && getAddress(tx.to) === zeroAddress && value > 0n && !this._config.allowBurn) {
      throw new UnsafeTransactionError('Refusing to send value to the zero address (set allowBurn to override).')
    }
  }

  private assertSafeTypedData(typed: TypedDataInput): void {
    const known = this.knownChainId()
    const raw = typed.domain.chainId
    const domainChain = typeof raw === 'bigint' ? Number(raw) : typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : undefined
    if (domainChain !== undefined && known !== undefined && domainChain !== known && !this._config.allowCrossChainTypedData) {
      throw new ChainMismatchError(known, domainChain, 'typed data')
    }
  }

  /** EIP-712. Accepts `{domain, types, message}`; `primaryType` is inferred when absent. */
  async signTypedData(typed: TypedDataInput): Promise<string> {
    this.assertSafeTypedData(typed)
    const types = cleanTypes(typed.types)
    const hash = hashTypedData({
      domain: typed.domain, types, primaryType: typed.primaryType ?? inferPrimaryType(types), message: typed.message,
    } as never)
    return this.serializeSignature(await this.signHash(hash, 'evm-712'))
  }

  /** ethers-shaped tx → viem serializable, filling gaps from the network when there is a client. */
  private async prepare(tx: EvmTransaction): Promise<TransactionSerializable> {
    const chainId = tx.chainId !== undefined ? Number(tx.chainId) : await this.getChainId()
    const nonce = tx.nonce ?? (await this.nextNonce())
    const to = tx.to !== undefined ? getAddress(tx.to) : undefined
    const value = toBigInt(tx.value) ?? 0n
    const data = (tx.data ?? '0x') as Hex
    const gas = await this.gasFor(tx)

    const legacy = tx.type === 0 || tx.type === 1 || (tx.gasPrice !== undefined && tx.maxFeePerGas === undefined)
    const base = { chainId, nonce, ...(to ? { to } : {}), value, data, gas }
    if (legacy) {
      const gasPrice = toBigInt(tx.gasPrice) ?? (await this.requireClient('read fee data').getGasPrice())
      return tx.type === 1
        ? { ...base, type: 'eip2930', gasPrice, accessList: tx.accessList ?? [] }
        : { ...base, type: 'legacy', gasPrice }
    }
    let maxFeePerGas = toBigInt(tx.maxFeePerGas)
    let maxPriorityFeePerGas = toBigInt(tx.maxPriorityFeePerGas)
    if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
      const fees = await this.requireClient('read fee data').estimateFeesPerGas()
      maxFeePerGas ??= fees.maxFeePerGas
      maxPriorityFeePerGas ??= fees.maxPriorityFeePerGas
    }
    if (tx.type === 4) {
      return { ...base, type: 'eip7702', maxFeePerGas, maxPriorityFeePerGas, accessList: tx.accessList ?? [], authorizationList: (tx.authorizationList ?? []) as never }
    }
    return { ...base, type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas, accessList: tx.accessList ?? [] }
  }

  /**
   * Everything that happens before a broadcast, in order: static refusals,
   * simulation (unless `simulate: false`), gas (taken from the simulation so
   * `estimateGas` runs once), fee cap. Returns the tx with `gasLimit` filled.
   */
  private async preflight(tx: EvmTransaction, limit: bigint | number | undefined, op: string): Promise<{ tx: EvmTransaction; fee: bigint }> {
    await this.getChainId() // network path: know the chain so a foreign tx.chainId is refused, not broadcast
    this.assertSafeTransaction(tx)
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
    const withGas: EvmTransaction = { ...tx, gasLimit }
    const { fee } = await this.quoteSendTransaction(withGas)
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
    return { tx: withGas, fee }
  }

  /**
   * Sign WITHOUT broadcasting. Fully-specified EIP-1559 / legacy txs sign
   * offline; the chain and zero-address refusals still apply. Simulation is
   * NOT run here (nothing is sent) — `sendTransaction` runs it.
   */
  async signTransaction(tx: EvmTransaction): Promise<string> {
    this.assertSafeTransaction(tx)
    if (this._config.transactionMaxFee !== undefined && this._client) {
      const { fee } = await this.quoteSendTransaction(tx)
      if (fee > BigInt(this._config.transactionMaxFee)) throw new Error('Exceeded maximum fee cost for transaction operation.')
    }
    const prepared = await this.prepare(tx)
    const hash = keccak256(serializeTransaction(prepared))
    return serializeTransaction(prepared, await this.signHash(hash, 'evm-tx'))
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

  private async signAndBroadcast(tx: EvmTransaction, limit: bigint | number | undefined, op: string): Promise<TransferResult> {
    const client = this.requireClient(op === 'transfer' ? 'transfer tokens' : 'send transactions')
    const ready = await this.preflight(tx, limit, op)
    // preflight already quoted and capped the fee; prepare() only fills nonce/fees now.
    const broadcast = async (prepared: TransactionSerializable): Promise<Hex> => {
      const raw = serializeTransaction(prepared, await this.signHash(keccak256(serializeTransaction(prepared)), 'evm-tx'))
      const hash = await client.sendRawTransaction({ serializedTransaction: raw as Hex })
      this._nonceFloor = { next: prepared.nonce! + 1, at: Date.now() }
      return hash
    }
    const prepared = await this.prepare(ready.tx)
    try {
      return { hash: await broadcast(prepared), fee: ready.fee }
    } catch (error) {
      // A nonce the caller fixed is theirs to retry. Otherwise one re-read:
      // the node that rejected us knows the real next nonce, and nothing was
      // broadcast, so re-signing the same payload is safe.
      const tooLow = ready.tx.nonce === undefined && NONCE_TOO_LOW.test(errorText(error))
      if (!tooLow) throw error
      const hinted = /next nonce (\d+)/i.exec(errorText(error))
      this._nonceFloor = { next: Math.max(prepared.nonce! + 1, hinted ? Number(hinted[1]) : 0), at: Date.now() }
      return { hash: await broadcast({ ...prepared, nonce: await this.nextNonce() }), fee: ready.fee }
    }
  }

  async sendTransaction(tx: EvmTransaction): Promise<TransferResult> {
    return this.signAndBroadcast(tx, this._config.transactionMaxFee, 'transaction')
  }

  async transfer(options: EvmTransferOptions): Promise<TransferResult> {
    return this.signAndBroadcast(transferTransaction(options), this._config.transferMaxFee, 'transfer')
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

  /** ERC-20 approve. Mainnet USDT non-zero → non-zero is refused or auto-reset (`autoResetAllowance`). */
  async approve(options: ApproveOptions): Promise<TransferResult> {
    const client = this.requireClient('approve funds')
    const token = getAddress(options.token)
    const spender = getAddress(options.spender)
    const amount = BigInt(options.amount)
    if (amount > 0n && (await this.getChainId()) === 1 && token.toLowerCase() === USDT_MAINNET) {
      const current = await this.getAllowance(token, spender)
      if (current > 0n) {
        if (!this._config.autoResetAllowance) {
          throw new Error('USDT requires the current allowance to be reset to 0 before setting a new non-zero value. Please send an "approve" transaction with an amount of 0 first.')
        }
        const reset = await this.sendTransaction({ to: token, value: 0n, data: encodeApprove(spender, 0n) })
        await client.waitForTransactionReceipt({ hash: reset.hash as Hex })
      }
    }
    return this.sendTransaction({ to: token, value: 0n, data: encodeApprove(spender, amount) })
  }

  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyEvm(this.address, this._config)
    return this._readOnly
  }

  /** Dispose the signer (zeroizes a local key). Idempotent. */
  dispose(): void {
    this.signer.dispose()
  }
}

export { ReadOnlyAccountError } from '@forgewallet/core'
