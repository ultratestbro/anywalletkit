import type { ReceiverKind } from './unified-address.js'

export type ZcashNetwork = 'mainnet' | 'testnet'

/** A lightwalletd / Zaino gRPC endpoint (TLS). */
export interface LightwalletdServer {
  host: string
  port: number
}

export interface ShieldedWalletConfig {
  network?: ZcashNetwork
  server: LightwalletdServer
  /**
   * Height to scan from. Notes received below it are never found, so use the height at which the
   * seed was created (or an earlier one); a lower height only costs sync time.
   */
  birthdayHeight: number
  /**
   * Names the wallet's databases on the device. One alias = one wallet: open the same seed again
   * with the same alias to continue its sync, a new alias starts from `birthdayHeight`.
   */
  alias: string
  /** The react-native-zcash entry point; injected by tests, the installed package otherwise. */
  native?: NativeZcash
}

/** One pool, zatoshi. `pending` = received or change not yet spendable (`total − spendable`). */
export interface PoolBalance {
  spendable: bigint
  total: bigint
  pending: bigint
}

export interface ShieldedBalance {
  transparent: PoolBalance
  sapling: PoolBalance
  /** Orchard notes left from before NU6.3 — move them with `migrateOrchard` (not implemented yet). */
  orchard: PoolBalance
  ironwood: PoolBalance
  /** Every pool together. */
  total: PoolBalance
}

export type SyncStatus = 'stopped' | 'disconnected' | 'syncing' | 'synced'

export interface SyncProgress {
  status: SyncStatus
  /** 0–100, from the SDK's scan progress. */
  percent: number
  /** Chain tip the SDK sees, or 0 before the first update. */
  networkHeight: number
}

export interface ShieldedAddresses {
  /** The unified address the SDK hands out for receiving. */
  unified: string
  /** Its transparent receiver as a t-address (the same key as `@anywalletkit/wallet-zcash` account 0). */
  transparent: string
  /** Sapling address of the account, as the SDK reports it. */
  sapling: string
  /** What the unified address carries, decoded here — not taken from the SDK. */
  receivers: { typecode: number; kind: ReceiverKind }[]
  /**
   * The address has an Orchard-format receiver (typecode 0x03). Ironwood has no typecode of its
   * own: it shares the Orchard receiver (librustzcash `zcash_keys` 0.17, `Address::can_receive_as`),
   * and after NU6.3 shielded value sent to it lands in Ironwood.
   */
  canReceiveIronwood: boolean
}

/** The parts of react-native-zcash this package uses (react-native-zcash ≥ 0.13.5, NU7 build). */
export interface NativeZcash {
  makeSynchronizer(config: {
    networkName: ZcashNetwork
    defaultHost: string
    defaultPort: number
    mnemonicSeed: string
    alias: string
    birthdayHeight: number
    newWallet: boolean
  }): Promise<NativeSynchronizer>
}

export interface NativeBalanceEvent {
  transparentAvailableZatoshi: string
  transparentTotalZatoshi: string
  saplingAvailableZatoshi: string
  saplingTotalZatoshi: string
  orchardAvailableZatoshi: string
  orchardTotalZatoshi: string
  ironwoodAvailableZatoshi: string
  ironwoodTotalZatoshi: string
}

export interface NativeSynchronizer {
  subscribe(callbacks: {
    onBalanceChanged(balance: NativeBalanceEvent): void
    onStatusChanged(status: { alias: string; name: 'STOPPED' | 'DISCONNECTED' | 'SYNCING' | 'SYNCED' }): void
    onTransactionsChanged(event: { transactions: unknown[] }): void
    onUpdate(event: { alias: string; scanProgress: number; networkBlockHeight: number }): void
    onError(error: { alias: string; level: 'critical' | 'error'; message: string }): void
  }): void
  deriveUnifiedAddress(): Promise<{ unifiedAddress: string; saplingAddress: string; transparentAddress: string }>
  getLatestNetworkHeight(alias: string): Promise<number>
  stop(): Promise<unknown>
}
