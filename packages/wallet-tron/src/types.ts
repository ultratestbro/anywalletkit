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
  /** Run `simulateTransaction` before signing in `sendTransaction` / `transfer` (default true). */
  simulate?: boolean
  /** Allow TRX / TRC-20 transfers to the zero address (default false — refused as a burn). */
  allowBurn?: boolean
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
    /** Memo, hex-encoded. Charged `getMemoFee` when present. */
    data?: string
  }
  /** Execution result the node attaches (also returned by `triggerconstantcontract` on revert: `ret: 'FAILED'`). */
  ret?: Array<{ ret?: string; contractRet?: string }>
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

/** What a transaction will cost, resource by resource. All sun values are what the SENDER burns. */
export interface TronFeeBreakdown {
  /** Free bandwidth points left on the account (`freeNetLimit − freeNetUsed`). */
  bandwidthFree: number
  /** Staked bandwidth points left (`NetLimit − NetUsed`). */
  bandwidthStaked: number
  /** Staked energy left (`EnergyLimit − EnergyUsed`). */
  energyStaked: number
  /** sun per energy unit (`getEnergyFee`). */
  energyPrice: bigint
  /** sun per bandwidth byte (`getTransactionFee`). */
  bandwidthPrice: bigint
  /** sun burned for a memo (`getMemoFee`), 0 without one. */
  memoFee: bigint
  /**
   * sun burned to create the recipient account: `getCreateNewAccountFeeInSystemContract` (1 TRX)
   * plus `getCreateAccountFee` (0.1 TRX) when staked bandwidth cannot cover the creation; 0 when it exists.
   */
  accountCreationFee: bigint
  /** sun burned for bandwidth not covered by staked/free allowance. */
  bandwidthBurn: bigint
  /** sun burned for energy not covered by staked energy. */
  energyBurn: bigint
}

export interface TronFeeEstimate {
  /** Bandwidth points the transaction consumes (serialized size + signature + 64-byte result reserve). */
  bandwidth: number
  /** Energy the call consumes (`energy_used` from a constant call); 0 for non-contract transactions. */
  energy: number
  /** Total sun the sender pays on top of the amount. */
  trxBurn: bigint
  breakdown: TronFeeBreakdown
}

export interface TronQuote {
  /** = `estimate.trxBurn`. */
  fee: bigint
  /** = `estimate.breakdown.accountCreationFee` (TransferContract to a new account). */
  activationFee: bigint
  estimate: TronFeeEstimate
}

/** Outcome of a constant call (`/wallet/triggerconstantcontract`) or a balance pre-check. */
export interface TronSimulation {
  ok: boolean
  /** `energy_used` reported by the node (0 for non-contract transactions). */
  energy: number
  /** Decoded revert reason / node message when `ok` is false. */
  reason?: string
  /** Raw `constant_result` entries. */
  constantResult?: string[] | undefined
}

export type TronTxKind = 'trx-transfer' | 'trc20-transfer' | 'trc20-approve' | 'contract-call' | 'freeze' | 'unfreeze' | 'unknown'
export type TronTxWarningCode = 'unlimited-approve' | 'zero-address' | 'unactivated-recipient' | 'memo-fee' | 'expired'
export interface TronTxWarning { code: TronTxWarningCode; message: string }

/** What a transaction does, decoded offline (see `describeTransaction`). Addresses are base58. */
export interface TronTxDescription {
  kind: TronTxKind
  warnings: TronTxWarning[]
  /** Sender (owner_address) when known. */
  from?: string
  /** TRX / TRC-20 recipient. */
  to?: string
  /** sun (TRX) or token base units (TRC-20) or frozen/unfrozen sun. */
  amount?: bigint
  /** TRC-20 contract. */
  token?: string
  spender?: string
  /** Called contract (contract-call). */
  contract?: string
  /** 4-byte selector, hex. */
  selector?: string
  /** sun attached to the call. */
  callValue?: bigint
  feeLimit?: number
  /** Decoded memo (`raw_data.data`). */
  memo?: string
  /** Freeze / unfreeze resource. */
  resource?: 'BANDWIDTH' | 'ENERGY'
  expiration?: number
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
