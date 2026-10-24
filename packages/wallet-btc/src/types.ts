/** Bitcoin mainnet, testnet or regtest. */
export type BtcNetwork = 'bitcoin' | 'testnet' | 'regtest'

/** Address / script type the account spends from. BIP-84 p2wpkh (bc1q…) or BIP-86 p2tr (bc1p…). */
export type BtcAddressType = 'p2wpkh' | 'p2tr'

/** Minimal chain-data client every transport implements. Values in satoshis, fee rates in sat/vB. */
export interface BtcClient {
  connect(): Promise<void>
  close(): Promise<void>
  getBalance(address: string): Promise<{ confirmed: bigint; unconfirmed: bigint; unconfirmedOutgoing?: bigint }>
  listUnspent(address: string): Promise<Utxo[]>
  getHistory(address: string): Promise<Array<{ txid: string; height: number }>>
  /** Raw transaction hex. */
  getTransaction(txid: string): Promise<string>
  /** Full tx record (used for receipts). */
  getTransactionInfo?(txid: string): Promise<BlockbookTx | undefined>
  /** Broadcast raw hex; returns the txid. */
  broadcast(rawTx: string): Promise<string>
  /** Fee rate in sat/vB for confirmation within `blocks`. */
  estimateFee(blocks: number): Promise<number>
  /** Current chain tip height (anti-fee-sniping locktime). Optional. */
  getBlockHeight?(): Promise<number>
}

/** An unspent output the account can spend. */
export interface Utxo {
  txid: string
  vout: number
  /** Satoshis. */
  value: bigint
  /** Block height; 0 or -1 while unconfirmed. */
  height: number
}

/** One transport to a Bitcoin indexer: Blockbook or Esplora over HTTP. */
export type BtcClientConfig =
  /** Trezor Blockbook REST (`https://btc1.trezor.io`, QuickNode's Blockbook add-on, …). */
  | { type: 'blockbook-http'; clientConfig: { url: string } }
  /** Esplora REST (`https://mempool.space/api`, `https://blockstream.info/api`). */
  | { type: 'esplora-http'; clientConfig: { url: string } }

/**
 * Options for a Bitcoin wallet manager or account: transports, network, address type and fee
 * limits.
 */
export interface BtcConfig {
  /** One or more transports (config objects or ready `BtcClient`s). A list fails over in order. Omit for an offline (sign-only) wallet. */
  client?: BtcClientConfig | BtcClient | Array<BtcClientConfig | BtcClient>
  /** Network; default `bitcoin` (mainnet). */
  network?: BtcNetwork
  /** p2wpkh (BIP-84, default) or p2tr (BIP-86 taproot). Changes the derivation path and the address. */
  addressType?: BtcAddressType
  /** Extra attempts across the client list after the first failure (default 3). */
  retries?: number
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number
  /** Max fee (sats) for `transfer`. */
  transferMaxFee?: bigint | number
  /** Max fee (sats) for `sendTransaction` / `signTransaction`. */
  transactionMaxFee?: bigint | number
  /** Fee-rate ceiling in sat/vB (default 500). Anything above is refused before signing or broadcast. */
  maxFeeRate?: number
  /** Coin-selection input cap (default 200). */
  maxInputs?: number
  /** Opt-in to replace-by-fee signalling (default true). */
  rbf?: boolean
  /** Set nLockTime to the current height so the tx cannot be mined into a reorg (default true; skipped when the transport has no `getBlockHeight`). */
  antiFeeSniping?: boolean
  /** Injectable fetch (tests, custom agents). Defaults to globalThis.fetch. */
  fetch?: typeof fetch
}

/** A spend. `value` in satoshis; `feeRate` in sat/vB (estimated for `confirmationTarget` blocks when omitted). */
export interface BtcSpend {
  to: string
  value: bigint | number | string
  feeRate?: bigint | number
  confirmationTarget?: number
  /** Override the account-level `rbf` default for this spend. */
  rbf?: boolean
}

/** `sendTransaction` accepts a spend or an already signed raw transaction hex. */
export type BtcTransaction = BtcSpend | string

/** A Bitcoin transfer. Amount in satoshis. */
export interface BtcTransferOptions {
  /** Not supported on Bitcoin; present for the shared account interface. */
  token?: string
  recipient: string
  amount: bigint | number | string
}

/** A mined Bitcoin transaction. */
export interface BtcReceipt {
  hash: string
  /** Always 1 once mined — a Bitcoin transaction cannot fail after inclusion. */
  status: 1
  blockNumber: bigint
  confirmations: number
  /** Total fee in sats (when the transport reports it). */
  fee?: bigint
  hex?: string
}

/** Transport-neutral tx record (Blockbook's /api/v2/tx shape; Esplora is mapped onto it). */
export interface BlockbookTx {
  txid: string
  blockHeight: number
  confirmations: number
  fees?: string
  hex?: string
  blockTime?: number
}

/** The most one transaction can send (a sweep of every UTXO), after the fee. */
export interface BtcMaxSpendableResult {
  /** Max sats one transaction can send after the fee. 0n when nothing is spendable. */
  amount: bigint
  fee: bigint
  /** Always 0n: a sweep leaves no change. */
  changeValue: bigint
  /** Inputs the sweep would consume. */
  inputs: number
  feeRate: bigint
}

/** Problems a described transaction is flagged with. */
export type BtcWarning =
  /** Fee rate above `maxFeeRate` (also a hard error before signing/broadcast). */
  | 'high-fee-rate'
  /** Fee exceeds 10 % of the amount sent. */
  | 'fee-over-10pct-of-amount'
  /** An output is below its dust threshold. */
  | 'dust-output'
  /** Change was below dust and folded into the fee. */
  | 'no-change'

/** One input of a described transaction: the UTXO it spends. */
export interface BtcTxInputDescription {
  txid: string
  vout: number
  value: bigint
}

/** One output of a described transaction, tagged as the recipient, our change, or unknown. */
export interface BtcTxOutputDescription {
  /** Undefined for scripts without an address form. */
  address: string | undefined
  value: bigint
  role: 'recipient' | 'change' | 'unknown'
}

/** "What you sign": the fully resolved transaction before (or after) signing. */
export interface BtcTxDescription {
  kind: 'btc-transfer'
  inputs: BtcTxInputDescription[]
  outputs: BtcTxOutputDescription[]
  /** Sats sent to non-change outputs. */
  amount: bigint
  fee: bigint
  /** sat/vB, rounded to 2 decimals. */
  feeRate: number
  vsize: number
  rbf: boolean
  lockTime: number
  /** Present once the transaction is signed. */
  txid?: string
  warnings: BtcWarning[]
}

/** CAIP-2 ids of the Bitcoin networks, by name. */
export const CAIP2_GENESIS: Record<BtcNetwork, string> = {
  bitcoin: 'bip122:000000000019d6689c085ae165831e93',
  testnet: 'bip122:000000000933ea01ad0ee984209779ba',
  regtest: 'bip122:0f9188f13cb7b2c71f2a335e3a4fc328',
}
