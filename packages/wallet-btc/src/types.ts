export type BtcNetwork = 'bitcoin' | 'testnet' | 'regtest'

/** Minimal chain-data client every transport implements. Values in satoshis, fee rates in sat/vB. */
export interface BtcClient {
  connect(): Promise<void>
  close(): Promise<void>
  getBalance(address: string): Promise<{ confirmed: bigint; unconfirmed: bigint; unconfirmedOutgoing?: bigint }>
  listUnspent(address: string): Promise<Utxo[]>
  getHistory(address: string): Promise<Array<{ txid: string; height: number }>>
  /** Raw transaction hex. */
  getTransaction(txid: string): Promise<string>
  /** Full Blockbook-style tx record (used for receipts). */
  getTransactionInfo?(txid: string): Promise<BlockbookTx | undefined>
  /** Broadcast raw hex; returns the txid. */
  broadcast(rawTx: string): Promise<string>
  /** Fee rate in sat/vB for confirmation within `blocks`. */
  estimateFee(blocks: number): Promise<number>
}

export interface Utxo {
  txid: string
  vout: number
  /** Satoshis. */
  value: bigint
  /** Block height; 0 or -1 while unconfirmed. */
  height: number
}

export type BtcClientConfig =
  | { type: 'blockbook-http'; clientConfig: { url: string } }
  /** Reserved: the Electrum-over-WebSocket transport is not implemented in this version. */
  | { type: 'electrum-ws'; clientConfig: { url: string } }

export interface BtcConfig {
  /** One or more transports (config objects or ready `BtcClient`s). A list fails over in order. Omit for an offline (sign-only) wallet. */
  client?: BtcClientConfig | BtcClient | Array<BtcClientConfig | BtcClient>
  network?: BtcNetwork
  /** Extra attempts across the client list after the first failure (default 3). */
  retries?: number
  /** Max fee (sats) for `transfer`. */
  transferMaxFee?: bigint | number
  /** Max fee (sats) for `sendTransaction` / `signTransaction`. */
  transactionMaxFee?: bigint | number
  /** Injectable fetch (tests, custom agents). Defaults to globalThis.fetch. */
  fetch?: typeof fetch
}

/** A spend. `value` in satoshis; `feeRate` in sat/vB (estimated for `confirmationTarget` blocks when omitted). */
export interface BtcSpend {
  to: string
  value: bigint | number | string
  feeRate?: bigint | number
  confirmationTarget?: number
}

/** `sendTransaction` accepts a spend or an already signed raw transaction hex. */
export type BtcTransaction = BtcSpend | string

export interface BtcTransferOptions {
  /** Not supported on Bitcoin; present for the shared account interface. */
  token?: string
  recipient: string
  amount: bigint | number | string
}

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

/** Subset of Blockbook's /api/v2/tx record. */
export interface BlockbookTx {
  txid: string
  blockHeight: number
  confirmations: number
  fees?: string
  hex?: string
  blockTime?: number
}

export const CAIP2_GENESIS: Record<BtcNetwork, string> = {
  bitcoin: 'bip122:000000000019d6689c085ae165831e93',
  testnet: 'bip122:000000000933ea01ad0ee984209779ba',
  regtest: 'bip122:0f9188f13cb7b2c71f2a335e3a4fc328',
}
