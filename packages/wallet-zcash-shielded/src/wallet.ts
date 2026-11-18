import { AddressCheckError, NotImplementedError, SyncError } from './errors.js'
import type {
  NativeBalanceEvent,
  NativeSynchronizer,
  NativeZcash,
  PoolBalance,
  ShieldedAddresses,
  ShieldedBalance,
  ShieldedWalletConfig,
  SyncProgress,
  SyncStatus,
  ZcashNetwork,
} from './types.js'
import { decodeUnifiedAddress, transparentReceiverAddress } from './unified-address.js'

const STATUS: Record<string, SyncStatus> = { STOPPED: 'stopped', DISCONNECTED: 'disconnected', SYNCING: 'syncing', SYNCED: 'synced' }

/** Proposal of a shielded send — the shape `send` will take once implemented. */
export interface ShieldedSendRequest {
  /** Unified, Sapling or transparent address. */
  recipient: string
  amount: bigint
  /** Only for shielded recipients; at most 512 bytes UTF-8. */
  memo?: string
}

export interface ShieldedSendResult {
  txid: string
}

/** What a wallet shows before signing a shielded transaction (`describeTransaction`, not implemented yet). */
export interface ShieldedTxDescription {
  /** Pools spent from and sent to. */
  fromPools: ('transparent' | 'sapling' | 'orchard' | 'ironwood')[]
  toPools: ('transparent' | 'sapling' | 'orchard' | 'ironwood')[]
  amount: bigint
  fee: bigint
  recipient: string
  memo?: string
  /** True when the recipient learns nothing about the sender's addresses (shielded → shielded). */
  fullyShielded: boolean
}

/**
 * A shielded Zcash account (ZIP-32 account 0 of the seed) on react-native-zcash.
 *
 * Keys: react-native-zcash takes the BIP-39 phrase when the synchronizer opens — the ZODL SDK
 * derives the unified spending key from it to create the account, then keeps only the viewing key
 * in its database. This class passes the phrase through once and does not keep it; the caller reads
 * it from secure storage right before `open` and drops it after. Spending (not implemented here yet)
 * takes the phrase again per transaction, the same way.
 */
export class ZcashShieldedWallet {
  readonly network: ZcashNetwork
  readonly alias: string
  private readonly sync: NativeSynchronizer
  private balance: ShieldedBalance | null = null
  private progress: SyncProgress = { status: 'disconnected', percent: 0, networkHeight: 0 }
  private lastError: SyncError | null = null
  private readonly progressListeners = new Set<(p: SyncProgress) => void>()
  private readonly balanceListeners = new Set<(b: ShieldedBalance) => void>()
  private readonly errorListeners = new Set<(e: SyncError) => void>()
  private closed = false

  private constructor(sync: NativeSynchronizer, network: ZcashNetwork, alias: string) {
    this.sync = sync
    this.network = network
    this.alias = alias
  }

  /**
   * Open (or create) the wallet `config.alias` for `seedPhrase` and start syncing from
   * `config.birthdayHeight`. The phrase goes to the native SDK once; see the class note.
   */
  static async open(seedPhrase: string, config: ShieldedWalletConfig): Promise<ZcashShieldedWallet> {
    if (!Number.isSafeInteger(config.birthdayHeight) || config.birthdayHeight < 1) throw new Error('birthdayHeight must be a positive block height.')
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.alias)) throw new Error(`Bad alias "${config.alias}" — 1–64 letters, digits, ".", "_", "-".`)
    const network = config.network ?? 'mainnet'
    const native = config.native ?? (await loadNative())
    const sync = await native.makeSynchronizer({
      networkName: network,
      defaultHost: config.server.host,
      defaultPort: config.server.port,
      mnemonicSeed: seedPhrase,
      alias: config.alias,
      birthdayHeight: config.birthdayHeight,
      newWallet: false,
    })
    const wallet = new ZcashShieldedWallet(sync, network, config.alias)
    wallet.attach()
    return wallet
  }

  private attach(): void {
    this.sync.subscribe({
      onBalanceChanged: (e) => {
        let next: ShieldedBalance
        try {
          next = toBalance(e)
        } catch (err) {
          // A malformed event is reported, never shown as a balance (and never thrown into the native emitter).
          return this.reportError('error', err instanceof Error ? err.message : String(err))
        }
        this.balance = next
        for (const l of this.balanceListeners) l(next)
      },
      onStatusChanged: (s) => this.setProgress({ status: STATUS[s.name] ?? this.progress.status }),
      onUpdate: (u) => {
        const percent = clampPercent(u.scanProgress)
        // iOS emits the first SYNCING status before JS has subscribed, so a running scan can arrive
        // with the status still "disconnected"; progress below 100 % from a live server means syncing.
        const inferSyncing = this.progress.status === 'disconnected' && u.networkBlockHeight > 0 && percent < 100
        this.setProgress({ ...(inferSyncing ? { status: 'syncing' as const } : {}), percent, networkHeight: u.networkBlockHeight > 0 ? u.networkBlockHeight : this.progress.networkHeight })
      },
      onTransactionsChanged: () => undefined,
      onError: (e) => this.reportError(e.level, e.message),
    })
  }

  private reportError(level: 'critical' | 'error', message: string): void {
    const err = new SyncError(level, message)
    this.lastError = err
    for (const l of this.errorListeners) l(err)
  }

  private setProgress(patch: Partial<SyncProgress>): void {
    this.progress = { ...this.progress, ...patch }
    if (this.progress.status === 'synced') this.progress.percent = 100
    for (const l of this.progressListeners) l(this.progress)
  }

  /**
   * The unified address for receiving, checked: it must decode, carry a transparent receiver equal
   * to the SDK's transparent address, and at least one shielded receiver.
   *
   * The transparent receiver sits at `m/44'/133'/0'/0/j`, where j is the diversifier index the SDK
   * chose for this address — not necessarily 0, so it may differ from `@anywalletkit/wallet-zcash`
   * account 0 of the same seed.
   */
  async getAddress(): Promise<ShieldedAddresses> {
    const a = await this.sync.deriveUnifiedAddress()
    const decoded = decodeUnifiedAddress(a.unifiedAddress)
    if (decoded.network !== this.network) throw new AddressCheckError(`The SDK returned a ${decoded.network} address for a ${this.network} wallet.`)
    const shielded = decoded.receivers.filter((r) => r.kind !== 'p2pkh' && r.kind !== 'p2sh')
    if (shielded.length === 0) throw new AddressCheckError('The unified address carries no shielded receiver.')
    const t = transparentReceiverAddress(decoded)
    if (t !== null && t !== a.transparentAddress) throw new AddressCheckError(`The unified address's transparent receiver ${t} is not the account's transparent address ${a.transparentAddress}.`)
    return {
      unified: a.unifiedAddress,
      transparent: a.transparentAddress,
      sapling: a.saplingAddress,
      receivers: decoded.receivers.map((r) => ({ typecode: r.typecode, kind: r.kind })),
      canReceiveIronwood: decoded.receivers.some((r) => r.kind === 'orchard'),
    }
  }

  /**
   * Balance per pool as of the last scan. Waits for the SDK's first balance report (it comes right
   * after `open`, from the database, before the scan reaches the tip). Read `getSyncProgress()` to
   * know whether the scan is complete — until `synced` the numbers can be low.
   */
  async getBalance(options: { timeoutMs?: number } = {}): Promise<ShieldedBalance> {
    if (this.balance) return this.balance
    const timeoutMs = options.timeoutMs ?? 30_000
    return new Promise<ShieldedBalance>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.balanceListeners.delete(listener)
        reject(this.lastError ?? new Error(`No balance from the Zcash SDK within ${timeoutMs} ms.`))
      }, timeoutMs)
      const listener = (b: ShieldedBalance) => {
        clearTimeout(timer)
        this.balanceListeners.delete(listener)
        resolve(b)
      }
      this.balanceListeners.add(listener)
    })
  }

  getSyncProgress(): SyncProgress {
    return this.progress
  }

  /** Called with every progress change; returns the unsubscribe function. */
  onSyncProgress(listener: (p: SyncProgress) => void): () => void {
    this.progressListeners.add(listener)
    listener(this.progress)
    return () => this.progressListeners.delete(listener)
  }

  /** Called with every new balance; returns the unsubscribe function. */
  onBalance(listener: (b: ShieldedBalance) => void): () => void {
    this.balanceListeners.add(listener)
    if (this.balance) listener(this.balance)
    return () => this.balanceListeners.delete(listener)
  }

  /** Called with every sync error the SDK reports; returns the unsubscribe function. */
  onError(listener: (e: SyncError) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  /** The chain tip as the server reports it. */
  getNetworkHeight(): Promise<number> {
    return this.sync.getLatestNetworkHeight(this.alias)
  }

  /**
   * TODO(SDK-229 M2): propose (`proposeTransfer`) → show `describeTransaction` → policies →
   * `createTransfer` with the phrase read from secure storage for this one call.
   */
  async send(_request: ShieldedSendRequest, _seedPhrase: string): Promise<ShieldedSendResult> {
    throw new NotImplementedError('send')
  }

  /** TODO(SDK-229 M2): move transparent funds into Ironwood (`shieldFunds`), above a threshold. */
  async shield(_seedPhrase: string, _options?: { threshold?: bigint; memo?: string }): Promise<ShieldedSendResult> {
    throw new NotImplementedError('shield')
  }

  /**
   * TODO(SDK-229 M2): sweep the Orchard notes into Ironwood (`proposeOrchardToIronwoodMigration`
   * → `createTransfer`). All-or-nothing: after NU6.3 value cannot go back into Orchard.
   */
  async migrateOrchard(_seedPhrase: string): Promise<ShieldedSendResult> {
    throw new NotImplementedError('migrateOrchard')
  }

  /** TODO(SDK-229 M2): decode a proposal into what the review screen shows. */
  async describeTransaction(_proposalBase64: string): Promise<ShieldedTxDescription> {
    throw new NotImplementedError('describeTransaction')
  }

  /** Stop syncing and drop the listeners. The wallet's databases stay on the device. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.progressListeners.clear()
    this.balanceListeners.clear()
    this.errorListeners.clear()
    await this.sync.stop()
  }
}

async function loadNative(): Promise<NativeZcash> {
  const mod = (await import('react-native-zcash')) as unknown as NativeZcash
  return mod
}

function zat(value: string | undefined): bigint {
  if (value === undefined || value === '') return 0n
  if (!/^\d+$/.test(value)) throw new Error(`The Zcash SDK reported a non-integer amount "${value}".`)
  return BigInt(value)
}

function pool(available: string | undefined, total: string | undefined): PoolBalance {
  const spendable = zat(available)
  const all = zat(total)
  return { spendable, total: all, pending: all > spendable ? all - spendable : 0n }
}

export function toBalance(e: NativeBalanceEvent): ShieldedBalance {
  const transparent = pool(e.transparentAvailableZatoshi, e.transparentTotalZatoshi)
  const sapling = pool(e.saplingAvailableZatoshi, e.saplingTotalZatoshi)
  const orchard = pool(e.orchardAvailableZatoshi, e.orchardTotalZatoshi)
  const ironwood = pool(e.ironwoodAvailableZatoshi, e.ironwoodTotalZatoshi)
  const sum = (k: keyof PoolBalance) => transparent[k] + sapling[k] + orchard[k] + ironwood[k]
  return { transparent, sapling, orchard, ironwood, total: { spendable: sum('spendable'), total: sum('total'), pending: sum('pending') } }
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0
  return Math.min(100, Math.max(0, p))
}
