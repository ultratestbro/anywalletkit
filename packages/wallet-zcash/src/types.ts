export type ZcashNetwork = 'mainnet' | 'testnet'

/** CAIP-2 ids the SDK uses for Zcash (the swap2 catalog already names `zcash:mainnet`). */
export const CAIP2: Record<ZcashNetwork, string> = { mainnet: 'zcash:mainnet', testnet: 'zcash:testnet' }

export interface Utxo {
  txid: string
  vout: number
  /** Zatoshis. */
  value: bigint
  /** Block height; -1 while in the mempool. */
  height: number
}

/** A previous output a transaction spends — ZIP-244 signs its value AND script. */
export interface SpentOutput {
  value: bigint
  script: Uint8Array
}

/** Transport-neutral transaction record (receipts, confirmations). */
export interface ZcashTxInfo {
  txid: string
  /** -1 or 0 while unconfirmed. */
  blockHeight: number
  confirmations: number
  fee?: bigint
  /** Unix seconds. */
  blockTime?: number
}

/** Minimal chain-data client every transport implements. Values in zatoshis. */
export interface ZcashClient {
  connect(): Promise<void>
  close(): Promise<void>
  getBalance(address: string): Promise<{ confirmed: bigint; unconfirmed: bigint }>
  listUnspent(address: string): Promise<Utxo[]>
  /** Raw transaction hex (any version — only used to read prevouts and for receipts). */
  getTransaction(txid: string): Promise<string>
  /** Value + scriptPubKey of one output of an existing transaction (what signing a spend of it needs). */
  getOutput(txid: string, vout: number): Promise<SpentOutput | undefined>
  getTransactionInfo(txid: string): Promise<ZcashTxInfo | undefined>
  /** Broadcast raw hex; returns the txid. */
  broadcast(rawTx: string): Promise<string>
  /** Current chain tip height (expiry height, anti-fee-sniping lock time, consensus branch selection). */
  getBlockHeight(): Promise<number>
}

export type ZcashClientConfig =
  /** Blockchair's public REST API (`https://api.blockchair.com/zcash`; optional API key). Mainnet only. */
  | { type: 'blockchair'; clientConfig?: { url?: string; key?: string } }
  /** A Zcash Blockbook (NOWNodes `https://zec-blockbook.nownodes.io` with an `api-key` header, a self-hosted instance, …). */
  | { type: 'blockbook-http'; clientConfig: { url: string; headers?: Record<string, string> } }

export interface ZcashConfig {
  /** One or more transports (config objects or ready `ZcashClient`s). A list fails over in order. Omit for an offline (sign-only) wallet. */
  client?: ZcashClientConfig | ZcashClient | Array<ZcashClientConfig | ZcashClient>
  network?: ZcashNetwork
  /** Extra attempts across the client list after the first failure (default 3). */
  retries?: number
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number
  /** Max fee (zatoshis) for `transfer`. */
  transferMaxFee?: bigint | number
  /** Max fee (zatoshis) for `sendTransaction` / `signTransaction`. */
  transactionMaxFee?: bigint | number
  /** Hard fee ceiling in zatoshis for any transaction this account signs or broadcasts (default 1 000 000 = 0.01 ZEC). */
  maxFee?: bigint | number
  /** Blocks after the tip at which an unmined transaction expires (ZIP-203; default 40, the zcashd/Zebra default). 0 = never. */
  expiryDelta?: number
  /** Set nLockTime to the tip height so the transaction cannot be mined into a reorged block (default true). */
  antiFeeSniping?: boolean
  /**
   * Consensus branch id to sign under. Default: picked from the tip height
   * (`branchIdForHeight`) — set this when a network upgrade activates before
   * the package learns its id.
   */
  consensusBranchId?: number
  /** Coin-selection input cap (default 200). */
  maxInputs?: number
  /** Injectable fetch (tests, custom agents). Defaults to globalThis.fetch. */
  fetch?: typeof fetch
}

/** A spend. `value` in zatoshis. `fee` overrides the ZIP-317 conventional fee (still subject to `maxFee`). */
export interface ZcashSpend {
  to: string
  value: bigint | number | string
  fee?: bigint | number
}

/** `sendTransaction` accepts a spend or an already signed raw transaction hex. */
export type ZcashTransaction = ZcashSpend | string

export interface ZcashTransferOptions {
  /** Not supported on Zcash; present for the shared account interface. */
  token?: string
  recipient: string
  amount: bigint | number | string
}

export interface ZcashReceipt {
  hash: string
  /** Always 1 once mined — a transparent transaction cannot fail after inclusion. */
  status: 1
  blockNumber: bigint
  confirmations: number
  fee?: bigint
}

export interface ZcashMaxSpendableResult {
  /** Max zatoshis one transaction can send after the fee. 0n when nothing is spendable. */
  amount: bigint
  fee: bigint
  /** Always 0n: a sweep leaves no change. */
  changeValue: bigint
  inputs: number
}

export type ZcashWarning =
  /** Fee exceeds 10 % of the amount sent. */
  | 'fee-over-10pct-of-amount'
  /** Fee is below the ZIP-317 conventional fee — nodes may not relay it. */
  | 'fee-below-conventional'
  /** An output is below the dust floor. */
  | 'dust-output'
  /** Change was below dust and folded into the fee. */
  | 'no-change'
  /** No expiry height: the transaction stays valid in mempools indefinitely. */
  | 'no-expiry'

export interface ZcashTxInputDescription {
  txid: string
  vout: number
  value: bigint
  address: string | undefined
}

export interface ZcashTxOutputDescription {
  /** Undefined for scripts without an address form. */
  address: string | undefined
  value: bigint
  role: 'recipient' | 'change' | 'unknown'
}

/** "What you sign": the fully resolved transaction before (or after) signing. */
export interface ZcashTxDescription {
  kind: 'zcash-transfer'
  version: 5
  consensusBranchId: number
  inputs: ZcashTxInputDescription[]
  outputs: ZcashTxOutputDescription[]
  /** Zatoshis sent to non-change outputs. */
  amount: bigint
  fee: bigint
  /** The ZIP-317 fee this transaction's shape calls for. */
  conventionalFee: bigint
  /** Serialized size in bytes. */
  size: number
  lockTime: number
  expiryHeight: number
  /** Present once the transaction is signed. */
  txid?: string
  warnings: ZcashWarning[]
}
