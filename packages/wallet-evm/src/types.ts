import type { EIP1193Provider, Hex } from 'viem'

/** One RPC endpoint or an EIP-1193 provider. */
export type EvmProvider = string | EIP1193Provider

export interface EvmConfig {
  /** RPC url(s) or EIP-1193 provider(s). A list fails over in order. Omit for an offline (sign-only) wallet. */
  provider?: EvmProvider | EvmProvider[]
  /** Extra attempts after the first failure across the provider list (default 3). */
  retries?: number
  /** Skip chain-id detection. Required for offline signing when the tx omits `chainId`. */
  chainId?: number
  /** Max fee (wei) for `transfer`; a quote above it throws before anything is sent. */
  transferMaxFee?: bigint | number
  /** Max fee (wei) for `sendTransaction` / `signTransaction`. */
  transactionMaxFee?: bigint | number
  /**
   * Ethereum-mainnet USDT reverts a non-zero → non-zero `approve`. By default the account
   * throws and asks the caller to approve(0) first; with this flag the account sends the
   * reset itself and waits for it before the real approval.
   */
  autoResetAllowance?: boolean
  /**
   * `eth_call` every transaction before signing it and refuse on revert
   * (SimulationError). Default true whenever a provider is configured.
   */
  simulate?: boolean
  /**
   * Multiplier applied to an ESTIMATED gas limit (simulation / estimateGas)
   * when the caller passes none. Default 1.2; 1 = no headroom.
   */
  gasHeadroom?: number
  /** Allow value transfers to the zero address (refused by default — UnsafeTransactionError). */
  allowBurn?: boolean
  /** Allow signing typed data whose domain names another chain (refused by default — ChainMismatchError). */
  allowCrossChainTypedData?: boolean
}

/**
 * A transaction in ethers shape (`gasLimit`, numeric `type`). Anything
 * missing is filled from the network when a provider is configured.
 */
export interface EvmTransaction {
  to?: string
  value?: bigint | number | string
  data?: Hex | string
  gasLimit?: bigint | number
  gasPrice?: bigint | number
  maxFeePerGas?: bigint | number
  maxPriorityFeePerGas?: bigint | number
  /** 0 legacy, 2 EIP-1559 (default when fee fields are 1559), 4 EIP-7702. */
  type?: number
  nonce?: number
  chainId?: number | bigint
  accessList?: Array<{ address: Hex; storageKeys: Hex[] }>
  authorizationList?: Array<{ chainId: number; address: Hex; nonce: number; r: Hex; s: Hex; yParity: number }>
  /** Ignored: always the account itself (kept so ethers-shaped objects pass through). */
  from?: string
}

export interface EvmTransferOptions {
  /** ERC-20 contract. Omit for native ETH. */
  token?: string
  recipient: string
  amount: bigint | number | string
}

export interface ApproveOptions {
  token: string
  spender: string
  amount: bigint | number | string
}

export interface TypedDataInput {
  domain: Record<string, unknown>
  types: Record<string, Array<{ name: string; type: string }>>
  message: Record<string, unknown>
  /** Inferred when omitted: the one type nothing else references. */
  primaryType?: string
}

export interface EvmReceipt {
  hash: string
  /** 1 success, 0 reverted — the convention protocol modules test. */
  status: 0 | 1
  blockNumber: bigint
  gasUsed: bigint
  effectiveGasPrice: bigint
  from: string
  to: string | null
  contractAddress: string | null
  logs: unknown[]
}

export type SimulationResult =
  | { ok: true; gas: bigint; returnData: Hex }
  | { ok: false; reason: string; data?: Hex }

export interface PermitOptions {
  token: string
  spender: string
  value: bigint | number | string
  /** Unix seconds. */
  deadline: bigint | number | string
}

export type PermitInfo =
  | { supported: false; reason: string }
  | { supported: true; name: string; version: string; nonce: bigint; domainSeparator: Hex; chainId: number }

export interface SignedPermit {
  signature: Hex
  v: number
  r: Hex
  s: Hex
  nonce: bigint
  deadline: bigint
  typedData: TypedDataInput
}
