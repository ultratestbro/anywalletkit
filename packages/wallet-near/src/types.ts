/** JSON-RPC transport: `method` + `params`, returns the `result` (throws on `error`). */
export type NearFetch = (method: string, params: unknown) => Promise<unknown>

/** One RPC base url (e.g. "https://free.rpc.fastnear.com") or a ready transport. */
export type NearProvider = string | NearFetch

export interface NearConfig {
  /** RPC url(s) / transport(s). A list fails over in order. Omit for an offline (sign-only) wallet. */
  provider?: NearProvider | NearProvider[]
  /** Extra attempts across the provider list after the first failure (default 3). */
  retries?: number
  /** Optional headers for every request (e.g. an API key). */
  headers?: Record<string, string>
  /** "mainnet" (default) | "testnet" | any CAIP-2 suffix. */
  network?: 'mainnet' | 'testnet' | string
  /** Max fee (yoctoNEAR) for `transfer`. */
  transferMaxFee?: bigint | number
  /** Max fee (yoctoNEAR) for `sendTransaction` / `signTransaction`. */
  transactionMaxFee?: bigint | number
  /** Run the balance / account / access-key preflight before signing (default true). */
  simulate?: boolean
  /**
   * Allow actions that change the account itself or deploy code (AddKey, DeleteKey,
   * DeleteAccount, DeployContract, Stake, CreateAccount, global-contract actions,
   * SignedDelegate). Default false: they are refused with `dangerous-action`.
   */
  allowDangerousActions?: boolean
}

// ── Actions ──────────────────────────────────────────────────────────────────

export interface NearTransferAction { transfer: { deposit: bigint } }
export interface NearFunctionCallAction {
  functionCall: {
    methodName: string
    /** Raw bytes, or a JSON-serialisable object / string (encoded as UTF-8 JSON). */
    args: Uint8Array | Record<string, unknown> | string
    /** Prepaid gas (default 30 Tgas). Max 300 Tgas. */
    gas?: bigint
    /** Attached deposit in yoctoNEAR (default 0). */
    deposit?: bigint
  }
}
export interface NearCreateAccountAction { createAccount: Record<string, never> }
export interface NearDeployContractAction { deployContract: { code: Uint8Array } }
export interface NearStakeAction { stake: { stake: bigint; publicKey: NearPublicKey } }
export interface NearAccessKey {
  nonce: bigint
  permission: { fullAccess: Record<string, never> } | { functionCall: { allowance?: bigint; receiverId: string; methodNames: string[] } }
}
export interface NearAddKeyAction { addKey: { publicKey: NearPublicKey; accessKey: NearAccessKey } }
export interface NearDeleteKeyAction { deleteKey: { publicKey: NearPublicKey } }
export interface NearDeleteAccountAction { deleteAccount: { beneficiaryId: string } }
export interface NearDelegateAction {
  senderId: string
  receiverId: string
  actions: NearAction[]
  nonce: bigint
  maxBlockHeight: bigint
  publicKey: NearPublicKey
}
export interface NearSignedDelegateAction { signedDelegate: { delegateAction: NearDelegateAction; signature: NearSignature } }
export interface NearDeployGlobalContractAction { deployGlobalContract: { code: Uint8Array; deployMode: 'codeHash' | 'accountId' } }
export interface NearUseGlobalContractAction { useGlobalContract: { codeHash: Uint8Array } | { accountId: string } }

export type NearAction =
  | NearCreateAccountAction
  | NearDeployContractAction
  | NearFunctionCallAction
  | NearTransferAction
  | NearStakeAction
  | NearAddKeyAction
  | NearDeleteKeyAction
  | NearDeleteAccountAction
  | NearSignedDelegateAction
  | NearDeployGlobalContractAction
  | NearUseGlobalContractAction

/** A public key as NEAR encodes it: curve tag + raw bytes. */
export interface NearPublicKey { keyType: 'ed25519' | 'secp256k1'; data: Uint8Array }
export interface NearSignature { keyType: 'ed25519' | 'secp256k1'; data: Uint8Array }

/**
 * A transaction to sign. `signerId` / `publicKey` default to the account's; `nonce` /
 * `blockHash` are fetched from the network when omitted (the account `needsNetwork`).
 */
export interface NearTransaction {
  receiverId: string
  actions: NearAction[]
  signerId?: string
  publicKey?: NearPublicKey
  nonce?: bigint
  /** 32 bytes, or base58. */
  blockHash?: Uint8Array | string
}

/** Fully specified transaction as it is hashed and signed. */
export interface NearBuiltTransaction {
  signerId: string
  publicKey: NearPublicKey
  nonce: bigint
  receiverId: string
  blockHash: Uint8Array
  actions: NearAction[]
}

export interface NearSignedTransaction { transaction: NearBuiltTransaction; signature: NearSignature }

/** Shorthand for `transfer`: native NEAR (no `token`) or a NEP-141 token (`token` = contract account id). */
export interface NearTransferOptions {
  token?: string
  recipient: string
  amount: bigint | number | string
  /** NEP-141 `memo` (ignored for native transfers — NEAR transfers carry no memo). */
  memo?: string
}

// ── Fees / preflight ────────────────────────────────────────────────────────

export interface NearFeeEstimate {
  /** Gas the transaction can burn at most (prepaid function-call gas counts in full). */
  gas: bigint
  /** yoctoNEAR per gas unit at quote time. */
  gasPrice: bigint
  /** Upper bound of the fee in yoctoNEAR (`gas * gasPrice`). */
  fee: bigint
  /** yoctoNEAR the actions attach (transfer deposits + function-call deposits). */
  deposit: bigint
  /** True when a native transfer will create an implicit account (extra gas included). */
  createsAccount: boolean
}

export interface NearQuote {
  /** = `estimate.fee`. */
  fee: bigint
  estimate: NearFeeEstimate
}

export interface NearSimulation {
  ok: boolean
  reason?: string
}

export interface NearAccountView {
  amount: bigint
  locked: bigint
  storageUsage: bigint
  /** `amount - locked - storageUsage * STORAGE_PRICE_PER_BYTE` (never below 0). */
  available: bigint
}

export interface NearReceipt {
  hash: string
  /** 1 success, 0 failed. */
  status: 0 | 1
  blockNumber?: bigint
  /** Decoded failure, when any receipt failed. */
  failure?: string
  /** Raw `tx` RPC payload. */
  raw: Record<string, unknown>
}

// ── Describe ─────────────────────────────────────────────────────────────────

export type NearTxKind =
  | 'near-transfer'
  | 'ft-transfer'
  | 'ft-storage-deposit'
  | 'function-call'
  | 'batch'
  | 'create-account'
  | 'deploy-contract'
  | 'stake'
  | 'add-key'
  | 'delete-key'
  | 'delete-account'
  | 'delegate'
  | 'global-contract'
export type NearTxWarningCode = 'dangerous-action' | 'full-access-key' | 'zero-amount' | 'implicit-new-account' | 'self-transfer' | 'high-gas' | 'unknown-method' | 'invalid-account'
export interface NearTxWarning { code: NearTxWarningCode; message: string }

export interface NearTxDescription {
  kind: NearTxKind
  warnings: NearTxWarning[]
  /** Signer account id when known. */
  from?: string
  /** Receiver account id (native transfer) or NEP-141 `receiver_id` (ft-transfer). */
  to?: string
  /** yoctoNEAR (native) or token base units (ft-transfer). */
  amount?: bigint
  /** NEP-141 contract account id. */
  token?: string
  /** NEP-141 memo. */
  memo?: string
  /** Called contract (function-call / batch). */
  contract?: string
  /** Methods called, in order. */
  methods?: string[]
  /** Total yoctoNEAR attached across actions. */
  deposit: bigint
  /** Total prepaid gas across function calls. */
  gas: bigint
  actionCount: number
}

// ── Constants ────────────────────────────────────────────────────────────────

export const CAIP2: Record<string, string> = { mainnet: 'near:mainnet', testnet: 'near:testnet' }

/** 1 NEAR = 10^24 yoctoNEAR. */
export const YOCTO = 10n ** 24n
/** 1 Tgas. */
export const TGAS = 10n ** 12n
/** Hard per-transaction prepaid gas limit. */
export const MAX_GAS = 300n * TGAS
/** Protocol storage price: 10^19 yoctoNEAR per byte. */
export const STORAGE_PRICE_PER_BYTE = 10n ** 19n
/** NEP-141 `ft_transfer` requires exactly 1 yoctoNEAR attached. */
export const ONE_YOCTO = 1n
/** Default gas for `ft_transfer` / `storage_deposit`. */
export const FT_TRANSFER_GAS = 30n * TGAS
export const STORAGE_DEPOSIT_GAS = 10n * TGAS
/** Minimum native transfer that can create an implicit account (covers its storage). */
export const IMPLICIT_ACCOUNT_MIN_DEPOSIT = 2n * 10n ** 21n // 0.002 NEAR
