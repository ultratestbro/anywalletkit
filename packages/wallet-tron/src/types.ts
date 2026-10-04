/** JSON-RPC-ish HTTP transport: POST `path` with a JSON body, returns parsed JSON. */
export type TronFetch = (path: string, body: unknown) => Promise<unknown>

/** One full-node base url (e.g. "https://api.trongrid.io") or a ready transport. */
export type TronProvider = string | TronFetch

export interface TronConfig {
  /** Full-node url(s) / transport(s). A list fails over in order. Omit for an offline (sign-only) wallet. */
  provider?: TronProvider | TronProvider[]
  /** Extra attempts across the provider list after the first failure (default 3). */
  retries?: number
  /** Optional headers for every request (e.g. `TRON-PRO-API-KEY`). */
  headers?: Record<string, string>
  /** Max fee (sun) for `transfer`. */
  transferMaxFee?: bigint | number
  /** Max fee (sun) for `sendTransaction` / `signTransaction`. */
  transactionMaxFee?: bigint | number
  /** CAIP-2 suffix; default mainnet genesis "0x2b6653dc". */
  network?: 'mainnet' | 'shasta' | 'nile' | string
}

/** Native TRX transfer. `value` in sun. */
export interface TronNativeTransfer { to: string; value: bigint | number | string }

/** Smart-contract call. */
export interface TronContractCall {
  contractAddress: string
  /** e.g. "transfer(address,uint256)" */
  functionSelector: string
  parameters?: Array<{ type: string; value: unknown }>
  options?: { feeLimit?: number; callValue?: number }
}

/** A transaction as the full node returns it (`/wallet/createtransaction`, `/wallet/triggersmartcontract`). */
export interface TronRawTransaction {
  txID: string
  raw_data_hex: string
  raw_data: {
    contract: Array<{ type: string; parameter: { value: Record<string, unknown>; type_url?: string } }>
    ref_block_bytes?: string
    ref_block_hash?: string
    expiration?: number
    timestamp?: number
    fee_limit?: number
  }
  visible?: boolean
  signature?: string[]
}

export type TronTransaction = TronNativeTransfer | TronContractCall | TronRawTransaction

export interface TronTransferOptions {
  /** TRC-20 contract (base58 T… or hex 41…). Omit for native TRX. */
  token?: string
  recipient: string
  amount: bigint | number | string
}

export interface TronQuote {
  fee: bigint
  /** 1 TRX when the recipient account does not exist yet (TransferContract only). */
  activationFee: bigint
}

export interface TronReceipt {
  hash: string
  /** 1 success, 0 failed. */
  status: 0 | 1
  blockNumber: bigint
  fee: bigint
  /** Raw `/wallet/gettransactioninfobyid` payload. */
  raw: Record<string, unknown>
}

export const CAIP2_GENESIS: Record<string, string> = {
  mainnet: 'tron:0x2b6653dc',
  shasta: 'tron:0x94a9059e',
  nile: 'tron:0xcd8690dc',
}
