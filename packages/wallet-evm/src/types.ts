import type { EIP1193Provider, Hex } from 'viem'

/** One RPC endpoint or an EIP-1193 provider. */
export type EvmProvider = string | EIP1193Provider

/**
 * Options for an EVM wallet manager or account: endpoints, chain id, fee caps and the pre-sign
 * safety checks.
 */
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
  /** Recipient or called contract; omit to deploy a contract. */
  to?: string
  /** Native value in wei. */
  value?: bigint | number | string
  /** Calldata, `0x`-prefixed. */
  data?: Hex | string
  /** Gas limit; estimated with `gasHeadroom` when omitted. */
  gasLimit?: bigint | number
  /** Legacy (type 0) gas price in wei. */
  gasPrice?: bigint | number
  /** EIP-1559 fee cap in wei. */
  maxFeePerGas?: bigint | number
  /** EIP-1559 tip in wei. */
  maxPriorityFeePerGas?: bigint | number
  /** 0 legacy, 2 EIP-1559 (default when fee fields are 1559), 4 EIP-7702. */
  type?: number
  /** Filled from the network (pending) when omitted. */
  nonce?: number
  /** Must match the account's chain; a mismatch throws `ChainMismatchError`. */
  chainId?: number | bigint
  /** EIP-2930 access list. */
  accessList?: Array<{ address: Hex; storageKeys: Hex[] }>
  /** EIP-7702 signed authorizations (type 4). */
  authorizationList?: Array<{ chainId: number; address: Hex; nonce: number; r: Hex; s: Hex; yParity: number }>
  /** Ignored: always the account itself (kept so ethers-shaped objects pass through). */
  from?: string
}

/** A native ETH or ERC-20 transfer. Amount in base units. */
export interface EvmTransferOptions {
  /** ERC-20 contract. Omit for native ETH. */
  token?: string
  /** Address that receives. */
  recipient: string
  /** Amount in wei or the token's base units. */
  amount: bigint | number | string
}

/** An ERC-20 `approve(spender, amount)`. */
export interface ApproveOptions {
  /** ERC-20 contract. */
  token: string
  /** Address allowed to spend. */
  spender: string
  /** Allowance in base units; 0 revokes. */
  amount: bigint | number | string
}

/** EIP-712 typed data, as `eth_signTypedData_v4` takes it. */
export interface TypedDataInput {
  /** EIP-712 domain (name, version, chainId, verifyingContract). */
  domain: Record<string, unknown>
  /** Type definitions; `EIP712Domain` may be included or left out. */
  types: Record<string, Array<{ name: string; type: string }>>
  /** The values to sign. */
  message: Record<string, unknown>
  /** Inferred when omitted: the one type nothing else references. */
  primaryType?: string
}

/** A mined transaction's receipt, in the shape protocol modules read. */
export interface EvmReceipt {
  /** Transaction hash. */
  hash: string
  /** 1 success, 0 reverted — the convention protocol modules test. */
  status: 0 | 1
  /** Block it was mined in. */
  blockNumber: bigint
  /** Gas the transaction used. */
  gasUsed: bigint
  /** Price per gas actually paid, in wei. */
  effectiveGasPrice: bigint
  /** Sender. */
  from: string
  /** Recipient or called contract; `null` for a deploy. */
  to: string | null
  /** Address of a deployed contract. */
  contractAddress: string | null
  /** Event logs, as viem returns them. */
  logs: unknown[]
}

/** Outcome of `simulateTransaction`: the gas used and return data, or the decoded revert reason. */
export type SimulationResult =
  | { ok: true; gas: bigint; returnData: Hex }
  | { ok: false; reason: string; data?: Hex }

/** An EIP-2612 permit to sign: `value` of `token` for `spender` until `deadline`. */
export interface PermitOptions {
  /** ERC-20 contract with `permit`. */
  token: string
  /** Address allowed to spend. */
  spender: string
  /** Allowance in base units. */
  value: bigint | number | string
  /** Unix seconds. */
  deadline: bigint | number | string
}

/** Whether a token supports EIP-2612, and its domain and the owner's nonce when it does. */
export type PermitInfo =
  | { supported: false; reason: string }
  | { supported: true; name: string; version: string; nonce: bigint; domainSeparator: Hex; chainId: number }

/** A signed EIP-2612 permit, in every form a contract call may need. */
export interface SignedPermit {
  /** 65-byte signature, `0x`-hex. */
  signature: Hex
  /** Signature `v`. */
  v: number
  /** Signature `r`. */
  r: Hex
  /** Signature `s`. */
  s: Hex
  /** Permit nonce that was signed. */
  nonce: bigint
  /** Deadline that was signed, unix seconds. */
  deadline: bigint
  /** The typed data that was signed. */
  typedData: TypedDataInput
}
