import {
  LendingProtocol, NotImplementedError,
  type ActivityItem, type ChainTx, type DescribeActivityContext, type IWalletAccountReadOnly,
} from '@anywalletkit/core'
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, ExecutionRevertedError,
  createPublicClient, custom, encodeFunctionData, getAddress, http, isAddress, zeroAddress,
  type Address, type Hex, type PublicClient,
} from 'viem'

import {
  DEPOSIT_QUEUE_ABI, ERC20_ABI, FEE_MANAGER_ABI, FLAGS_SELECTOR, ORACLE_ABI, REDEEM_QUEUE_ABI, SHARE_MANAGER_ABI, VAULT_ABI,
} from './abi.js'
import { MELLOW_ADDRESS_MAP, type MellowVaultPreset } from './address-map.js'
import { describeMellowActivity } from './activity.js'

/** Default timeout for the module's REST reads (APR, rewards, queue times): an API that never answers must not hang the caller. */
const API_TIMEOUT_MS = 15_000

/** `fetch` with a timeout: `AbortSignal.timeout` where the runtime has it, else a timer (Hermes without runtime-hermes). */
async function fetchWithTimeout(url: string, ms = API_TIMEOUT_MS): Promise<Response> {
  let signal: AbortSignal | undefined
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') signal = AbortSignal.timeout(ms)
  else if (typeof AbortController !== 'undefined') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms) as unknown as { unref?: () => void }
    timer.unref?.()
    signal = controller.signal
  }
  return fetch(url, signal ? { signal } : {})
}

/** The vault's id for native ETH (the ERC-7528 placeholder). */
export const NATIVE_ASSET = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
/** Mellow's public vault registry — APY / TVL / withdrawal time (decoration only). */
export const DEFAULT_REGISTRY = 'https://api.mellow.finance/v1/vaults'
const E18 = 10n ** 18n
const MAX_UINT224 = (1n << 224n) - 1n

// ---- public types ----

/** A minimal EIP-1193 provider: anything with `request({ method, params })`. */
export interface Eip1193Like {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}
/** An RPC url or an EIP-1193 provider. */
export type EvmProvider = string | Eip1193Like

/** A transaction as the module hands it to the account (approvals carry no `value`). */
export interface MellowTx { to: string; data: string; value?: bigint }
/** A fully specified call: `value` always present. */
export interface MellowCall { to: string; data: string; value: bigint }

/**
 * The account surface this module uses. `getAddress` is enough for every
 * view; writes need `sendTransaction` (and `quoteSendTransaction` for fee
 * quotes). A full `@anywalletkit/wallet-evm` account satisfies it.
 */
export interface MellowAccount {
  getAddress(): Promise<string>
  sendTransaction?(tx: MellowTx): Promise<{ hash: string; fee?: bigint | number | string }>
  quoteSendTransaction?(tx: MellowTx): Promise<{ fee?: bigint | number | string }>
  /** The wallet account's own provider, used when `config.provider` is absent. */
}

export interface SupplyOptions {
  /** Asset address, or "native" for ETH. */
  token: string
  /** Amount in the asset's base units. */
  amount: number | bigint
  /** Not supported — the queues credit the depositor. */
  onBehalfOf?: string
}

export interface SupplyResult {
  hash: string
  fee: bigint
  /** True when the synchronous queue minted shares in this transaction. */
  instant: boolean
  /** The deposit queue used. */
  queue: string
  /** Approval transactions sent (awaited) before the deposit. */
  approveHashes: string[]
}

export interface WithdrawOptions {
  /** Payout asset address, or "native". */
  token: string
  /** Vault SHARES to redeem (18 decimals). */
  amount: number | bigint
  /** Not supported — the redeem queue pays the requesting account. */
  to?: string
}

export interface WithdrawResult {
  hash: string
  fee: bigint
  /** The redeem queue used. */
  queue: string
  /** Estimated payout at the latest report, after the redeem fee. */
  assetsOut: bigint
}

export interface QueueInfo {
  address: string
  paused: boolean
}
export interface DepositQueueInfo extends QueueInfo {
  kind: 'async' | 'sync'
}
export interface RedeemQueueInfo extends QueueInfo {
  kind: 'async' | 'signature'
}

export interface VaultAsset {
  address: string
  native: boolean
  depositQueues: DepositQueueInfo[]
  redeemQueues: RedeemQueueInfo[]
}

export interface VaultData {
  vault: string
  shareManager: string
  feeManager: string
  oracle: string
  riskManager: string
  assets: VaultAsset[]
  /** Percent. */
  fees: { depositPct: number; redeemPct: number; performancePct: number; protocolPct: number }
  /** Seconds. */
  oracleParams: { timeout: number; depositInterval: number; redeemInterval: number }
  flags: { hasWhitelist: boolean; hasMintPause: boolean; hasBurnPause: boolean }
}

export interface OracleReport {
  /** Shares per one unit of the asset, 1e18 fixed point. */
  priceD18: bigint
  /** Unix seconds. */
  timestamp: number
  suspicious: boolean
}

export interface PendingDeposit {
  token: string
  queue: string
  requestedAt: number
  assets: bigint
}

export interface RedeemRequest {
  token: string
  queue: string
  /** Unix seconds — the request's id inside its queue. */
  timestamp: number
  shares: bigint
  claimable: boolean
  /** Priced after the report; 0 until then. */
  assets: bigint
}

export interface Position {
  /** Shares held (18 decimals), including those priced but not yet claimed. */
  shares: bigint
  /** Asset the shares are valued in. */
  token: string
  priceD18: bigint
  /** Value of the shares in `token` at the latest report. */
  value: bigint
  reportAt: number
  suspicious: boolean
  claimableShares: bigint
  pendingDeposits: PendingDeposit[]
  redeemRequests: RedeemRequest[]
}

export interface WithdrawalRequestsView {
  requests: Array<RedeemRequest & { id: string }>
  pendingShares: bigint
  claimable: Array<{ token: string; queue: string; assets: bigint; timestamps: number[] }>
}

export interface Stats {
  id: string
  name: string
  apy: number | null
  tvlUsd: number | null
  withdrawAvgSeconds: number | null
}

export interface SupplyPlan {
  queue: DepositQueueInfo
  approvals: Array<{ to: string; data: string }>
  tx: MellowCall
  sharesOut: bigint
  instant: boolean
}

export interface WithdrawPlan {
  queue: string
  tx: MellowCall
  assetsOut: bigint
}

export interface MellowProtocolConfig {
  /** The Core Vault address. Required unless `preset` names a known vault. */
  vault?: string
  /** A key of `MELLOW_ADDRESS_MAP` (e.g. 'lido-earn-eth', 'lido-earn-usd'). */
  preset?: string
  /** The chain the vault lives on (default 1). Only used to pick presets and label errors. */
  chainId?: number
  /** RPC url or EIP-1193 provider to read the chain through. Defaults to the account's own provider. */
  provider?: EvmProvider
  /** Mellow's vault registry URL for APY / TVL / withdrawal time (decoration). `null` disables it. */
  registry?: string | null
  /** Try the vault's synchronous deposit queue first (shares in the same transaction), fall back to the async queue (default true). */
  instant?: boolean
  /** Referral address forwarded to the deposit queues (default zero address). */
  referral?: string
  /** How many redeem requests to read per queue (default 50). */
  maxRedeemRequests?: number
}

// ---- helpers ----

/** Normalizes and validates an amount option (base units). */
function toAmount(amount: number | bigint): bigint {
  if (typeof amount !== 'bigint' && !(typeof amount === 'number' && Number.isSafeInteger(amount))) {
    throw new Error("'amount' must be a bigint or a safe integer (in base unit).")
  }
  const value = BigInt(amount)
  if (value <= 0n) {
    throw new Error("'amount' should be greater than zero.")
  }
  return value
}

/**
 * Normalizes a token option to the vault's asset id: 'native' / the zero
 * address / the ERC-7528 placeholder all mean ETH. Returns a checksummed address.
 */
export function toAsset(token?: string | null): string {
  if (token === undefined || token === null || token === 'native' || token === 'ETH') return NATIVE_ASSET
  if (!isAddress(token)) throw new Error("'token' must be a valid address or 'native'.")
  const a = getAddress(token)
  return a === zeroAddress ? NATIVE_ASSET : a
}

/**
 * Only a revert says "this contract has no such method": a reverted call, a
 * call that returned no data, or the node's "execution reverted". A transport
 * error (rate limit, batch rejected, timeout) is anything else.
 */
function isRevert(e: unknown): boolean {
  return e instanceof BaseError && e.walk((err) => err instanceof ContractFunctionRevertedError || err instanceof ContractFunctionZeroDataError || err instanceof ExecutionRevertedError) !== null
}

type RegistryEntry = { id?: unknown; name?: unknown; address?: unknown; apy?: unknown; tvl_usd?: unknown; withdraw_avg_time_seconds?: unknown }

/**
 * Mellow Core Vaults for EVM wallet accounts — Lido's Earn vaults (EarnETH,
 * EarnUSD, stRATEGY) and any other vault on the same contracts.
 *
 * A Core Vault holds LP money that a curator allocates across DeFi through
 * verified sub-vault calls; LPs hold vault **shares** (earnETH, earnUSD, …)
 * priced by the vault's oracle once per report (~daily). Money moves through
 * per-asset queues the vault itself lists on-chain:
 *
 *  - **supply** — `deposit` into the asset's queue. The synchronous queue
 *    mints shares in the same transaction at the last report's price (used
 *    first when `instant` is on); the asynchronous queue records a request
 *    that the next report prices, after which the shares are counted in the
 *    account's balance without any further action (`claimShares` only moves
 *    them physically). One open async request per account; cancellable until
 *    it is priced (`cancelSupply`).
 *  - **withdraw** — `redeem(shares)` on the asset's redeem queue: the shares
 *    burn at once, the request is *not* cancellable, the next report at least
 *    `redeemInterval` later prices it, the curator pulls liquidity, and
 *    `claimWithdrawals` pays the asset out. That second phase is what makes
 *    this a two-step withdraw; `getWithdrawalRequests` reports the queue.
 *
 * Reads run through the account's provider (viem). Every queue is found
 * on-chain (`getQueueCount` / `queueAt`, classified by the methods it
 * answers) and re-verified against the vault (`hasQueue`, direction, pause)
 * before money touches it; a suspicious oracle report or a whitelist gate
 * refuses instead of pricing blindly. Mellow's registry only decorates.
 *
 * `borrow` / `repay` reject: a vault does not lend.
 */
export default class MellowProtocolEvm extends LendingProtocol<MellowProtocolConfig> {
  /** The vault this protocol talks to. */
  readonly vault: string
  private readonly _acct: MellowAccount
  private readonly _chainId: number
  private readonly _preset: MellowVaultPreset | null
  private readonly _registry: string | null
  private readonly _instant: boolean
  private readonly _referral: Address
  private readonly _maxRedeemRequests: number
  private readonly _client: PublicClient | undefined
  private _vaultData: VaultData | null = null

  /**
   * Creates a new interface to a Mellow Core Vault for evm blockchains.
   *
   * @param account - The wallet account (a @anywalletkit/wallet-evm account, or a read-only `{ getAddress }` one for views).
   * @param config - The protocol's configuration.
   */
  constructor(account: MellowAccount, config: MellowProtocolConfig = {}) {
    super(account as unknown as IWalletAccountReadOnly, config)
    this._acct = account

    const chainId = config.chainId ?? 1
    const preset = config.preset ? MELLOW_ADDRESS_MAP[chainId]?.[config.preset] : undefined
    if (config.preset && !preset) {
      throw new Error(`Unknown Mellow preset '${config.preset}' on chain ${chainId}.`)
    }
    const vault = config.vault ?? preset?.vault
    if (!vault || !isAddress(vault)) {
      throw new Error("'vault' must be a Core Vault address (or 'preset' a key of MELLOW_ADDRESS_MAP).")
    }
    this.vault = getAddress(vault)
    this._chainId = chainId
    this._preset = preset ?? null
    this._registry = config.registry === undefined ? DEFAULT_REGISTRY : config.registry
    this._instant = config.instant ?? true
    const referral = config.referral ?? zeroAddress
    if (referral !== zeroAddress && !isAddress(referral)) {
      throw new Error("'referral' must be a valid address.")
    }
    this._referral = referral as Address
    this._maxRedeemRequests = config.maxRedeemRequests ?? 50

    // wallet-evm keeps the RPC in a protected `_config`: read it without putting it in the account type.
    const provider = config.provider ?? (account as { _config?: { provider?: EvmProvider } } | undefined)?._config?.provider
    if (provider) {
      // Discovery fires many reads at once; send them one per request — some gateways answer a batch member with empty data.
      this._client = createPublicClient({ transport: typeof provider === 'string' ? http(provider, { batch: false }) : custom(provider) })
    }
  }

  private _requireProvider(): PublicClient {
    if (!this._client) {
      throw new Error('The protocol must be initialized with a provider (or an account configured with one).')
    }
    return this._client
  }

  private _requireWritable(method: string): void {
    // Structural, deliberately not instanceof: a duplicated copy of the
    // account package fails instanceof while the account works fine.
    if (typeof this._acct?.sendTransaction !== 'function') {
      throw new Error(`The '${method}' method requires the protocol to be initialized with a non read-only account.`)
    }
  }

  // ---- Discovery ----

  /**
   * Classifies a queue by the methods it answers: an async deposit queue has
   * `requestOf`, a sync one does not; a redeem queue has `requestsOf`, a
   * signature queue does not.
   */
  private async _classifyQueue(address: Address, isDeposit: true): Promise<'async' | 'sync'>
  private async _classifyQueue(address: Address, isDeposit: false): Promise<'async' | 'signature'>
  private async _classifyQueue(address: Address, isDeposit: boolean): Promise<'async' | 'sync' | 'signature'>
  private async _classifyQueue(address: Address, isDeposit: boolean): Promise<'async' | 'sync' | 'signature'> {
    // Only a revert says "this contract has no such method"; a transport error
    // (rate limit, batch rejected, timeout) must not reclassify a queue.
    const probe = async (read: () => Promise<unknown>): Promise<boolean> => {
      try {
        await read()
        return true
      } catch (e) {
        if (isRevert(e)) return false
        throw e
      }
    }
    const client = this._requireProvider()
    if (isDeposit) {
      return (await probe(() => client.readContract({ address, abi: DEPOSIT_QUEUE_ABI, functionName: 'requestOf', args: [zeroAddress] }))) ? 'async' : 'sync'
    }
    return (await probe(() => client.readContract({ address, abi: REDEEM_QUEUE_ABI, functionName: 'requestsOf', args: [zeroAddress, 0n, 1n] }))) ? 'async' : 'signature'
  }

  /**
   * The vault's components, assets and queues as the chain reports them,
   * plus the fee and oracle parameters. Cached per instance (queues change
   * rarely); pass `{ refresh: true }` to re-read.
   */
  async getVaultData({ refresh = false }: { refresh?: boolean } = {}): Promise<VaultData> {
    if (this._vaultData && !refresh) return this._vaultData
    const client = this._requireProvider()
    const vault = this.vault as Address
    const v = <F extends 'shareManager' | 'feeManager' | 'oracle' | 'riskManager' | 'getAssetCount'>(functionName: F) =>
      client.readContract({ address: vault, abi: VAULT_ABI, functionName })
    const [shareManager, feeManager, oracle, riskManager, assetCount] = await Promise.all([
      v('shareManager'), v('feeManager'), v('oracle'), v('riskManager'), v('getAssetCount'),
    ])
    // Assets and their queues are read in parallel (order kept): sequentially
    // this was ~100 round trips per vault, 5-11 s on a phone.
    const range = (n: bigint): bigint[] => Array.from({ length: Number(n) }, (_, i) => BigInt(i))
    const assets: VaultAsset[] = await Promise.all(range(assetCount).map(async (i) => {
      const asset = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'assetAt', args: [i] })
      const queueCount = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'getQueueCount', args: [asset] })
      const queues = await Promise.all(range(queueCount).map(async (j) => {
        const q = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'queueAt', args: [asset, j] })
        const [isDeposit, paused] = await Promise.all([
          client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'isDepositQueue', args: [q] }),
          client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'isPausedQueue', args: [q] }),
        ])
        return { address: q, isDeposit, paused, kind: await this._classifyQueue(q, isDeposit) }
      }))
      const depositQueues: DepositQueueInfo[] = queues.filter((q) => q.isDeposit).map(({ address, kind, paused }) => ({ address, kind: kind as 'async' | 'sync', paused }))
      const redeemQueues: RedeemQueueInfo[] = queues.filter((q) => !q.isDeposit).map(({ address, kind, paused }) => ({ address, kind: kind as 'async' | 'signature', paused }))
      return { address: asset, native: asset === NATIVE_ASSET, depositQueues, redeemQueues }
    }))
    const fee = (functionName: 'depositFeeD6' | 'redeemFeeD6' | 'performanceFeeD6' | 'protocolFeeD6'): Promise<number> =>
      client.readContract({ address: feeManager, abi: FEE_MANAGER_ABI, functionName }).catch(() => 0)
    const [depositFee, redeemFee, performanceFee, protocolFee] = await Promise.all([
      fee('depositFeeD6'), fee('redeemFeeD6'), fee('performanceFeeD6'), fee('protocolFeeD6'),
    ])
    const params = await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'securityParams' })
    const flags = await this._readFlags(shareManager)
    this._vaultData = {
      vault: this.vault,
      shareManager,
      feeManager,
      oracle,
      riskManager,
      assets,
      fees: {
        depositPct: Number(depositFee) / 1e4,
        redeemPct: Number(redeemFee) / 1e4,
        performancePct: Number(performanceFee) / 1e4,
        protocolPct: Number(protocolFee) / 1e4,
      },
      oracleParams: { timeout: Number(params.timeout), depositInterval: Number(params.depositInterval), redeemInterval: Number(params.redeemInterval) },
      flags: {
        hasWhitelist: Boolean(flags?.hasWhitelist),
        hasMintPause: Boolean(flags?.hasMintPause),
        hasBurnPause: Boolean(flags?.hasBurnPause),
      },
    }
    return this._vaultData
  }

  /**
   * The share manager's `flags()` as raw words: the first four are the mint
   * pause, burn pause, transfer pause and deposit-whitelist booleans on every
   * deployed version; the lockup tail varies and is ignored.
   */
  private async _readFlags(shareManager: Address): Promise<{ hasMintPause: boolean; hasBurnPause: boolean; hasTransferPause: boolean; hasWhitelist: boolean } | null> {
    try {
      const raw: string = (await this._requireProvider().call({ to: shareManager, data: FLAGS_SELECTOR })).data ?? '0x'
      const word = (i: number): boolean => raw.length >= 2 + 64 * (i + 1) && BigInt('0x' + raw.slice(2 + 64 * i, 2 + 64 * (i + 1))) !== 0n
      return { hasMintPause: word(0), hasBurnPause: word(1), hasTransferPause: word(2), hasWhitelist: word(3) }
    } catch {
      return null
    }
  }

  /**
   * The oracle's latest report for an asset: shares per one unit of the asset (1e18 fixed point).
   *
   * @param token - The asset (default native).
   */
  async getReport(token?: string): Promise<OracleReport> {
    const { oracle } = await this.getVaultData()
    const r = await this._requireProvider().readContract({ address: oracle as Address, abi: ORACLE_ABI, functionName: 'getReport', args: [toAsset(token) as Address] })
    return { priceD18: BigInt(r.priceD18), timestamp: Number(r.timestamp), suspicious: Boolean(r.isSuspicious) }
  }

  private async _asset(token?: string): Promise<VaultAsset> {
    const asset = toAsset(token)
    const data = await this.getVaultData()
    const entry = data.assets.find((a) => a.address.toLowerCase() === asset.toLowerCase())
    if (!entry) throw new Error(`The vault does not accept ${asset}.`)
    return entry
  }

  /**
   * Re-checks a queue against the vault right before money touches it:
   * it must be the vault's own, of the wanted direction, and not paused.
   */
  private async _verifyQueue(queue: string, wantDeposit: boolean): Promise<void> {
    const client = this._requireProvider()
    const vault = this.vault as Address
    const q = queue as Address
    const [has, isDeposit, paused] = await Promise.all([
      client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'hasQueue', args: [q] }),
      client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'isDepositQueue', args: [q] }),
      client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'isPausedQueue', args: [q] }),
    ])
    if (!has || isDeposit !== wantDeposit) throw new Error(`Queue ${queue} is not a ${wantDeposit ? 'deposit' : 'redeem'} queue of vault ${this.vault}.`)
    if (paused) throw new Error(`Queue ${queue} is paused right now — try again later.`)
  }

  // ---- Position ----

  /**
   * Vault shares the account holds (18 decimals), including shares priced by
   * a report but not yet physically claimed.
   */
  async getShares(): Promise<bigint> {
    const { shareManager } = await this.getVaultData()
    const account = (await this._acct.getAddress()) as Address
    return BigInt(await this._requireProvider().readContract({ address: shareManager as Address, abi: SHARE_MANAGER_ABI, functionName: 'activeSharesOf', args: [account] }))
  }

  /**
   * The account's position: shares, their value in `token` at the latest
   * report, and what sits in the queues.
   *
   * @param options - Asset to value the shares in (default native, or the first vault asset when the vault has no native leg).
   */
  async getPosition({ token }: { token?: string } = {}): Promise<Position> {
    const data = await this.getVaultData()
    const client = this._requireProvider()
    const account = (await this._acct.getAddress()) as Address
    const valueAsset = token !== undefined ? toAsset(token) : (data.assets.find((a) => a.native) ?? data.assets[0]!).address
    const [shares, report] = await Promise.all([this.getShares(), this.getReport(valueAsset)])
    const pendingDeposits: PendingDeposit[] = []
    const redeemRequests: RedeemRequest[] = []
    let claimableShares = 0n
    const async_ = <Q extends QueueInfo & { kind: string }>(qs: Q[]): Q[] => qs.filter((q) => q.kind === 'async')
    const [deposits, redeems] = await Promise.all([
      Promise.all(data.assets.flatMap((asset) => async_(asset.depositQueues).map(async (q) => {
        const address = q.address as Address
        const [req, claimable] = await Promise.all([
          client.readContract({ address, abi: DEPOSIT_QUEUE_ABI, functionName: 'requestOf', args: [account] }),
          client.readContract({ address, abi: DEPOSIT_QUEUE_ABI, functionName: 'claimableOf', args: [account] }).catch(() => 0n),
        ])
        return { asset, q, req, claimable }
      }))),
      Promise.all(data.assets.flatMap((asset) => async_(asset.redeemQueues).map(async (q) => ({
        asset, q, reqs: await client.readContract({ address: q.address as Address, abi: REDEEM_QUEUE_ABI, functionName: 'requestsOf', args: [account, 0n, BigInt(this._maxRedeemRequests)] }),
      })))),
    ])
    for (const { asset, q, req, claimable } of deposits) {
      const [timestamp, assets] = req
      claimableShares += BigInt(claimable)
      if (BigInt(assets) > 0n) pendingDeposits.push({ token: asset.address, queue: q.address, requestedAt: Number(timestamp), assets: BigInt(assets) })
    }
    for (const { asset, q, reqs } of redeems) {
      for (const r of reqs) {
        redeemRequests.push({ token: asset.address, queue: q.address, timestamp: Number(r.timestamp), shares: BigInt(r.shares), claimable: Boolean(r.isClaimable), assets: BigInt(r.assets) })
      }
    }
    redeemRequests.sort((a, b) => b.timestamp - a.timestamp)
    return {
      shares,
      token: valueAsset,
      priceD18: report.priceD18,
      value: report.priceD18 > 0n ? (shares * E18) / report.priceD18 : 0n,
      reportAt: report.timestamp,
      suspicious: report.suspicious,
      claimableShares,
      pendingDeposits,
      redeemRequests,
    }
  }

  // ---- Supply ----

  /**
   * Builds a deposit: verifies the queue, settles the ERC-20 allowance
   * (Ethereum's USDT wants a reset to zero before a raise), optionally
   * proves the call with an eth_call.
   */
  private async _prepareDeposit(asset: VaultAsset, queue: DepositQueueInfo, amount: bigint, { prove }: { prove: boolean }): Promise<{ approvals: Array<{ to: string; data: string }>; tx: MellowCall }> {
    await this._verifyQueue(queue.address, true)
    const client = this._requireProvider()
    const account = (await this._acct.getAddress()) as Address
    const spender = queue.address as Address
    const approvals: Array<{ to: string; data: string }> = []
    if (!asset.native) {
      const allowance = BigInt(await client.readContract({ address: asset.address as Address, abi: ERC20_ABI, functionName: 'allowance', args: [account, spender] }))
      if (allowance < amount) {
        if (allowance > 0n) approvals.push({ to: asset.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, 0n] }) })
        approvals.push({ to: asset.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }) })
      }
    }
    const tx: MellowCall = { to: queue.address, data: encodeFunctionData({ abi: DEPOSIT_QUEUE_ABI, functionName: 'deposit', args: [amount, this._referral, []] }), value: asset.native ? amount : 0n }
    if (prove && approvals.length === 0) {
      await client.call({ account, to: tx.to as Address, data: tx.data as Hex, value: tx.value })
    }
    return { approvals, tx }
  }

  /**
   * The transaction(s) a supply needs and the queue it goes to.
   *
   * @param token - The asset.
   * @param amount - The amount (base units).
   */
  protected async _getSupplyPlan(token: string, amount: bigint, { instant = this._instant }: { instant?: boolean } = {}): Promise<SupplyPlan> {
    if (amount > MAX_UINT224) throw new Error("'amount' exceeds the queue's uint224 limit.")
    const asset = await this._asset(token)
    const data = await this.getVaultData()
    if (data.flags.hasWhitelist) throw new Error('This vault gates deposits with a whitelist (merkle proof) — not supported.')
    if (data.flags.hasMintPause) throw new Error('This vault has minting paused.')
    const report = await this.getReport(asset.address)
    if (report.suspicious) throw new Error("The oracle's latest report for this asset is flagged suspicious — deposits wait for an accepted report.")
    if (report.priceD18 === 0n) throw new Error('The oracle has no price for this asset yet.')
    const gross = (amount * report.priceD18) / E18
    const sharesOut = gross - (gross * BigInt(Math.round(data.fees.depositPct * 1e4))) / 1_000_000n

    const sync = asset.depositQueues.find((q) => q.kind === 'sync' && !q.paused)
    const async = asset.depositQueues.find((q) => q.kind === 'async' && !q.paused)
    if (instant && sync) {
      try {
        const plan = await this._prepareDeposit(asset, sync, amount, { prove: true })
        if (plan.approvals.length === 0) return { queue: sync, ...plan, sharesOut, instant: true }
        // An approval is still pending: the proof cannot run yet; the sync queue
        // stays the target only if its report is fresh enough to not revert.
        const age = Math.floor(Date.now() / 1000) - report.timestamp
        if (age < data.oracleParams.timeout) return { queue: sync, ...plan, sharesOut, instant: true }
      } catch {
        // stale report or a paused sync queue — take the async road
      }
    }
    if (!async) throw new Error(`The vault has no open deposit queue for ${asset.address}.`)
    const account = (await this._acct.getAddress()) as Address
    const [, openAssets] = await this._requireProvider().readContract({ address: async.address as Address, abi: DEPOSIT_QUEUE_ABI, functionName: 'requestOf', args: [account] })
    if (BigInt(openAssets) > 0n) {
      throw new Error('The account already has an open deposit request in this queue — wait for the next report or cancel it first.')
    }
    const plan = await this._prepareDeposit(asset, async, amount, { prove: false })
    return { queue: async, ...plan, sharesOut, instant: false }
  }

  private async _send(tx: MellowTx): Promise<{ hash: string; fee: bigint }> {
    const result = await this._acct.sendTransaction!(tx)
    if (!result?.hash) throw new Error('The account returned no transaction hash.')
    return { hash: result.hash, fee: BigInt(result.fee ?? 0) }
  }

  private async _sendAndWait(tx: MellowTx): Promise<{ hash: string; fee: bigint }> {
    const sent = await this._send(tx)
    const receipt = await this._requireProvider().waitForTransactionReceipt({ hash: sent.hash as Hex, confirmations: 1, timeout: 180_000 })
    if (!receipt || receipt.status !== 'success') throw new Error(`Transaction ${sent.hash} reverted.`)
    return sent
  }

  private async _quoteFee(txs: MellowTx[]): Promise<bigint> {
    if (typeof this._acct?.quoteSendTransaction !== 'function') return 0n
    let fee = 0n
    for (const tx of txs) fee += BigInt((await this._acct.quoteSendTransaction(tx)).fee ?? 0)
    return fee
  }

  /**
   * Supplies an asset to the vault. ERC-20 legs approve first (awaited to a
   * mined receipt); the synchronous queue is used when it can mint at once,
   * otherwise the request enters the asynchronous queue and the next report
   * prices it.
   *
   * @param options - `token` (address or 'native') and `amount` in base units. `onBehalfOf` is not supported.
   * @returns The result, whether shares minted at once, and the queue used.
   */
  override async supply({ token, amount, onBehalfOf }: SupplyOptions): Promise<SupplyResult> {
    this._requireWritable('supply(options)')
    if (onBehalfOf) throw new Error("'onBehalfOf' is not supported: Mellow queues credit the depositor.")
    const value = toAmount(amount)
    let plan = await this._getSupplyPlan(token, value)
    const approveHashes: string[] = []
    let fee = 0n
    for (const approval of plan.approvals) {
      const sent = await this._sendAndWait(approval)
      approveHashes.push(sent.hash)
      fee += sent.fee
    }
    if (plan.instant && plan.approvals.length > 0) {
      // The proof could not run before the allowance was mined; run it now, and
      // take the async queue if the sync one would revert (stale report).
      try {
        await this._requireProvider().call({ account: (await this._acct.getAddress()) as Address, to: plan.tx.to as Address, data: plan.tx.data as Hex, value: plan.tx.value })
      } catch {
        plan = await this._getSupplyPlan(token, value, { instant: false })
      }
    }
    const sent = await this._send(plan.tx)
    return { hash: sent.hash, fee: fee + sent.fee, instant: plan.instant, queue: plan.queue.address, approveHashes }
  }

  /**
   * Quotes a supply: network fee (approvals included), shares at the latest report, and the queue it would take.
   */
  override async quoteSupply({ token, amount }: SupplyOptions): Promise<{ fee: bigint; sharesOut: bigint; instant: boolean; queue: string }> {
    const plan = await this._getSupplyPlan(token, toAmount(amount))
    return { fee: await this._quoteFee([...plan.approvals, plan.tx]), sharesOut: plan.sharesOut, instant: plan.instant, queue: plan.queue.address }
  }

  /**
   * Cancels the account's open asynchronous deposit request for an asset (only before a report prices it).
   */
  async cancelSupply({ token }: { token?: string } = {}): Promise<{ hash: string; fee: bigint }> {
    this._requireWritable('cancelSupply(options)')
    const asset = await this._asset(token)
    const q = asset.depositQueues.find((x) => x.kind === 'async')
    if (!q) throw new Error('No asynchronous deposit queue for this asset.')
    const account = (await this._acct.getAddress()) as Address
    const [, openAssets] = await this._requireProvider().readContract({ address: q.address as Address, abi: DEPOSIT_QUEUE_ABI, functionName: 'requestOf', args: [account] })
    if (BigInt(openAssets) === 0n) throw new Error('No open deposit request to cancel.')
    return await this._send({ to: q.address, data: encodeFunctionData({ abi: DEPOSIT_QUEUE_ABI, functionName: 'cancelDepositRequest' }), value: 0n })
  }

  /**
   * Moves shares a report already priced from the asset's deposit queue to the
   * account. Optional — balances count them either way; cheap and idempotent.
   */
  async claimShares({ token }: { token?: string } = {}): Promise<{ hash: string; fee: bigint }> {
    this._requireWritable('claimShares(options)')
    const asset = await this._asset(token)
    const q = asset.depositQueues.find((x) => x.kind === 'async')
    if (!q) throw new Error('No asynchronous deposit queue for this asset.')
    const account = (await this._acct.getAddress()) as Address
    return await this._send({ to: q.address, data: encodeFunctionData({ abi: DEPOSIT_QUEUE_ABI, functionName: 'claim', args: [account] }), value: 0n })
  }

  // ---- Withdraw ----

  /**
   * @param token - The payout asset.
   * @param shares - Shares to redeem.
   */
  protected async _getWithdrawPlan(token: string, shares: bigint): Promise<WithdrawPlan> {
    const asset = await this._asset(token)
    const data = await this.getVaultData()
    const q = asset.redeemQueues.find((x) => x.kind === 'async' && !x.paused)
    if (!q) throw new Error(`The vault has no open redeem queue paying ${asset.address}.`)
    if (data.flags.hasBurnPause) throw new Error('This vault has redemptions paused.')
    const held = await this.getShares()
    if (shares > held) throw new Error(`The amount exceeds the account's shares (${held}).`)
    const report = await this.getReport(asset.address)
    if (report.suspicious) throw new Error("The oracle's latest report for this asset is flagged suspicious — redemptions wait for an accepted report.")
    await this._verifyQueue(q.address, false)
    const net = shares - (shares * BigInt(Math.round(data.fees.redeemPct * 1e4))) / 1_000_000n
    const assetsOut = report.priceD18 > 0n ? (net * E18) / report.priceD18 : 0n
    return { queue: q.address, tx: { to: q.address, data: encodeFunctionData({ abi: REDEEM_QUEUE_ABI, functionName: 'redeem', args: [shares] }), value: 0n }, assetsOut }
  }

  /**
   * Requests a redemption: `amount` is in **shares** (the only unit known
   * before the report); they burn at once and the request is not cancellable.
   * The payout in `token` becomes claimable after the next report that is at
   * least `redeemInterval` later and the curator's liquidity handling —
   * see {@link getWithdrawalRequests} and {@link claimWithdrawals}.
   *
   * @param options - `token` = payout asset, `amount` = shares. `to` is not supported.
   * @returns The result, the queue and the estimated payout.
   */
  override async withdraw({ token, amount, to }: WithdrawOptions): Promise<WithdrawResult> {
    this._requireWritable('withdraw(options)')
    if (to) throw new Error("'to' is not supported: the redeem queue pays the requesting account.")
    const plan = await this._getWithdrawPlan(token, toAmount(amount))
    const sent = await this._send(plan.tx)
    return { ...sent, queue: plan.queue, assetsOut: plan.assetsOut }
  }

  /**
   * Quotes a redemption request: network fee and the payout at the latest report (after the redeem fee).
   */
  override async quoteWithdraw({ token, amount }: WithdrawOptions): Promise<{ fee: bigint; assetsOut: bigint; queue: string }> {
    const plan = await this._getWithdrawPlan(token, toAmount(amount))
    return { fee: await this._quoteFee([plan.tx]), assetsOut: plan.assetsOut, queue: plan.queue }
  }

  /**
   * The account's redemption queue across every payout asset: requests newest
   * first, shares still waiting, and what is claimable per asset.
   */
  async getWithdrawalRequests(): Promise<WithdrawalRequestsView> {
    const { redeemRequests } = await this.getPosition()
    const requests = redeemRequests.map((r) => ({ id: `${r.queue}:${r.timestamp}`, ...r }))
    let pendingShares = 0n
    const byQueue = new Map<string, { token: string; queue: string; assets: bigint; timestamps: number[] }>()
    for (const r of requests) {
      if (!r.claimable) {
        pendingShares += r.shares
        continue
      }
      const entry = byQueue.get(r.queue) ?? { token: r.token, queue: r.queue, assets: 0n, timestamps: [] }
      entry.assets += r.assets
      entry.timestamps.push(r.timestamp)
      byQueue.set(r.queue, entry)
    }
    return { requests, pendingShares, claimable: [...byQueue.values()] }
  }

  /**
   * Claims processed redemptions — the asset lands on the account. One
   * transaction per payout asset; `token` picks one, otherwise every asset
   * with claimable requests is swept in sequence.
   *
   * @param options - Restrict to a payout asset and/or specific request timestamps.
   * @returns The transactions sent and what they claim.
   */
  async claimWithdrawals({ token, timestamps }: { token?: string; timestamps?: number[] } = {}): Promise<{ hashes: string[]; fee: bigint; assets: Array<{ token: string; amount: bigint }> }> {
    this._requireWritable('claimWithdrawals(options)')
    const { claimable } = await this.getWithdrawalRequests()
    const wanted = token !== undefined ? toAsset(token).toLowerCase() : null
    const targets = claimable
      .filter((c) => !wanted || c.token.toLowerCase() === wanted)
      .map((c) => ({ ...c, timestamps: timestamps ? c.timestamps.filter((t) => timestamps.includes(t)) : c.timestamps }))
      .filter((c) => c.timestamps.length > 0)
    if (targets.length === 0) throw new Error('Nothing is claimable yet.')
    const account = (await this._acct.getAddress()) as Address
    const hashes: string[] = []
    let fee = 0n
    const assets: Array<{ token: string; amount: bigint }> = []
    for (const t of targets) {
      const sent = await this._send({ to: t.queue, data: encodeFunctionData({ abi: REDEEM_QUEUE_ABI, functionName: 'claim', args: [account, t.timestamps] }), value: 0n })
      hashes.push(sent.hash)
      fee += sent.fee
      assets.push({ token: t.token, amount: t.assets })
    }
    return { hashes, fee, assets }
  }

  // ---- Not lending ----

  /** Always rejects: a Mellow vault does not lend. */
  override async borrow(_options: unknown): Promise<never> {
    throw new NotImplementedError('borrow(options): Mellow vaults do not lend.')
  }

  /** Always rejects. */
  override async quoteBorrow(_options: unknown): Promise<never> {
    throw new NotImplementedError('quoteBorrow(options): Mellow vaults do not lend.')
  }

  /** Always rejects. */
  override async repay(_options: unknown): Promise<never> {
    throw new NotImplementedError('repay(options): Mellow vaults do not lend.')
  }

  /** Always rejects. */
  override async quoteRepay(_options: unknown): Promise<never> {
    throw new NotImplementedError('quoteRepay(options): Mellow vaults do not lend.')
  }

  // ---- Registry (decoration) ----

  /**
   * The vault's entry in Mellow's registry: APY, TVL, average withdrawal time. Null when the registry is disabled, unreachable, or does not list the vault.
   */
  async getStats(): Promise<Stats | null> {
    if (!this._registry) return null
    try {
      const res = await fetchWithTimeout(this._registry)
      if (!res.ok) return null
      const list = (await res.json()) as RegistryEntry[]
      const entry = list.find((v) => typeof v.address === 'string' && v.address.toLowerCase() === this.vault.toLowerCase()) ??
        (this._preset ? list.find((v) => v.id === this._preset!.registryId) : undefined)
      if (!entry) return null
      return {
        id: entry.id as string,
        name: (entry.name ?? entry.id) as string,
        apy: typeof entry.apy === 'number' ? entry.apy : null,
        tvlUsd: typeof entry.tvl_usd === 'number' ? entry.tvl_usd : null,
        withdrawAvgSeconds: typeof entry.withdraw_avg_time_seconds === 'number' ? entry.withdraw_avg_time_seconds : null,
      }
    } catch {
      return null
    }
  }

  /**
   * The vault's APY in percent, from Mellow's registry.
   */
  async getApr(): Promise<number> {
    const stats = await this.getStats()
    if (!stats || stats.apy === null) throw new Error('APY needs the Mellow registry (config.registry) and a listed vault.')
    return stats.apy
  }

  /**
   * Recognize Mellow queue transactions offline (`deposit`, `cancelDepositRequest`,
   * `claim` on deposit queues; `redeem`, `claim` on redeem queues) for the preset
   * vaults and the vault this instance targets. See `activity.ts` for the rule.
   */
  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    return describeMellowActivity(tx, ctx, { chainId: this._chainId, vault: this.vault, shareManager: this._preset?.shareManager ?? this._vaultData?.shareManager ?? null })
  }
}
