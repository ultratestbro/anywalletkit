// Plumbing both Morpho protocols share: the viem client over the account's or
// the config's provider, sends that wait on the account's receipts, eth_call
// proofs with Morpho reverts decoded, exact ERC-20 approvals.
import { LendingProtocol, NetworkError, type IWalletAccount, type IWalletAccountReadOnly } from '@forgewallet/core'
import {
  createPublicClient, custom, encodeFunctionData, fallback, getAddress, http,
  type Abi, type Address, type EIP1193Provider, type Hex, type PublicClient, type Transport,
} from 'viem'
import { ERC20_ABI } from './abi.js'
import { MORPHO_CHAINS, type MorphoChain } from './chains.js'
import { MorphoApi } from './api.js'
import { MorphoError, toMorphoError } from './errors.js'

export type EvmProvider = string | EIP1193Provider

export interface MorphoBaseConfig {
  /** Chain (default: the account's `eip155:N`, else 1). Must have a Morpho deployment. */
  chainId?: number
  /** Override the Morpho (Blue) singleton for a chain not in the presets. */
  morpho?: string
  /** RPC url(s) / EIP-1193 provider(s) to read through. Defaults to the account's own. */
  provider?: EvmProvider | EvmProvider[]
  /** Morpho API endpoint for APY / listing, or `null` to disable (default: api.morpho.org). */
  api?: string | null
  /** How long an approval may take to mine before the main transaction (default 180 000 ms). */
  waitTimeoutMs?: number
}

export interface Tx { to: Address; data: Hex; value: bigint; gasLimit?: bigint }

/** Gas used for a fee quote when the real estimate cannot run yet (allowance still pending). */
export const FALLBACK_GAS = { approve: 60_000n, vault: 320_000n, market: 260_000n } as const

export type AmountOption = bigint | number | 'max'

export function toAmount(amount: bigint | number | string): bigint {
  if (typeof amount !== 'bigint' && !(typeof amount === 'number' && Number.isSafeInteger(amount))) {
    throw new MorphoError("'amount' must be a bigint or a safe integer (in base units), or 'max' where allowed.")
  }
  const value = BigInt(amount)
  if (value <= 0n) throw new MorphoError("'amount' should be greater than zero.")
  return value
}

const toTransport = (p: EvmProvider): Transport => (typeof p === 'string' ? http(p) : custom(p))

export abstract class MorphoBase<TConfig extends MorphoBaseConfig> extends LendingProtocol<TConfig> {
  readonly chainId: number
  readonly chain: MorphoChain
  protected readonly api: MorphoApi | null
  private readonly _client: PublicClient | undefined
  private readonly _waitTimeout: number

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig) {
    super(account, config)
    const accountChain = /^eip155:(\d+)$/.exec(account?.chain ?? '')
    this.chainId = config.chainId ?? (accountChain ? Number(accountChain[1]) : 1)
    if (accountChain && Number(accountChain[1]) !== this.chainId) {
      throw new MorphoError(`The account is on eip155:${accountChain[1]} but the protocol is configured for eip155:${this.chainId}.`)
    }
    const preset = MORPHO_CHAINS[this.chainId]
    if (!preset && !config.morpho) throw new MorphoError(`No known Morpho deployment on chain ${this.chainId}; pass 'morpho' explicitly.`)
    this.chain = preset
      ? (config.morpho ? { ...preset, morpho: getAddress(config.morpho) } : preset)
      : { chainId: this.chainId, name: `eip155:${this.chainId}`, morpho: getAddress(config.morpho!), vaultV1Factories: [], vaultV2Factories: [] }
    this.api = config.api === null ? null : new MorphoApi(config.api)
    this._waitTimeout = config.waitTimeoutMs ?? 180_000
    const raw = config.provider ?? (account as unknown as { _config?: { provider?: EvmProvider | EvmProvider[] } })?._config?.provider
    if (raw !== undefined) {
      const list = Array.isArray(raw) ? raw : [raw]
      if (list.length > 0) this._client = createPublicClient({ transport: list.length === 1 ? toTransport(list[0]!) : fallback(list.map(toTransport)) })
    }
  }

  protected get client(): PublicClient {
    if (!this._client) throw new NetworkError('The protocol must be initialized with a provider (or an account configured with one).')
    return this._client
  }

  protected async read<T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client.readContract({ address, abi: abi as Abi, functionName, args } as never) as Promise<T>
  }

  protected encode(abi: readonly unknown[], functionName: string, args: readonly unknown[]): Hex {
    return encodeFunctionData({ abi: abi as Abi, functionName, args } as never)
  }

  protected async me(): Promise<Address> {
    return getAddress(await this._account.getAddress())
  }

  protected writable(method: string): IWalletAccount {
    return this.requireSigningAccount(`${method}(options)`)
  }

  protected async send(tx: Tx): Promise<{ hash: string; fee: bigint }> {
    const account = this.requireSigningAccount('send')
    const { gasLimit: _g, ...clean } = tx
    const result = await account.sendTransaction(clean)
    if (!result?.hash) throw new MorphoError('The account returned no transaction hash.')
    return { hash: result.hash, fee: BigInt(result.fee ?? 0) }
  }

  protected async wait(hash: string): Promise<void> {
    const deadline = Date.now() + this._waitTimeout
    for (;;) {
      const receipt = await this._account.getTransactionReceipt(hash)
      if (receipt) {
        if (receipt.status !== 1) throw new MorphoError(`Transaction ${hash} reverted.`)
        return
      }
      if (Date.now() > deadline) throw new NetworkError(`Transaction ${hash} was not mined within ${this._waitTimeout} ms.`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  /** `eth_call` from the account; a Morpho / vault revert becomes a readable MorphoError. */
  protected async prove(tx: Tx, action: string): Promise<void> {
    try {
      await this.client.call({ account: await this.me(), to: tx.to, data: tx.data, value: tx.value })
    } catch (e) {
      toMorphoError(e, action)
    }
  }

  protected async quoteFee(txs: Tx[]): Promise<bigint> {
    let fee = 0n
    for (const tx of txs) {
      const { gasLimit, ...clean } = tx
      fee += BigInt((await this._account.quoteSendTransaction(gasLimit !== undefined ? { ...clean, gasLimit } : clean)).fee ?? 0)
    }
    return fee
  }

  /** Exact-amount ERC-20 approvals, with the approve(0) reset Ethereum's USDT demands before a raise. */
  protected async approvals(token: Address, spender: Address, amount: bigint): Promise<Tx[]> {
    const owner = await this.me()
    const allowance = await this.read<bigint>(token, ERC20_ABI, 'allowance', [owner, spender])
    if (allowance >= amount) return []
    const out: Tx[] = []
    if (allowance > 0n) out.push({ to: token, data: this.encode(ERC20_ABI, 'approve', [spender, 0n]), value: 0n, gasLimit: FALLBACK_GAS.approve })
    out.push({ to: token, data: this.encode(ERC20_ABI, 'approve', [spender, amount]), value: 0n, gasLimit: FALLBACK_GAS.approve })
    return out
  }

  /** Approvals (each awaited to a receipt), then the main transaction, proven first. */
  protected async execute(plan: { approvals: Tx[]; tx: Tx }, action: string): Promise<{ hash: string; fee: bigint; approveHashes: string[] }> {
    const approveHashes: string[] = []
    let fee = 0n
    for (const a of plan.approvals) {
      const sent = await this.send(a)
      await this.wait(sent.hash)
      approveHashes.push(sent.hash)
      fee += sent.fee
    }
    await this.prove(plan.tx, action)
    const sent = await this.send(plan.tx)
    return { hash: sent.hash, fee: fee + sent.fee, approveHashes }
  }

  protected async tokenMeta(token: Address): Promise<{ symbol: string; decimals: number }> {
    const [symbol, decimals] = await Promise.all([
      this.read<string>(token, ERC20_ABI, 'symbol').catch(() => '?'),
      this.read<number>(token, ERC20_ABI, 'decimals').catch(() => 18),
    ])
    return { symbol, decimals: Number(decimals) }
  }
}
