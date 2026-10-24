/**
 * The account surface protocol modules are written against.
 */

/** A transfer of the chain's native token or of a token on it. Amounts in base units. */
export interface TransferOptions {
  /** Token identifier (contract, mint, jetton master). Omit for the native token. */
  token?: string
  /** Address that receives the funds. */
  recipient: string
  /** Amount in base units (wei, lamports, satoshi…). */
  amount: bigint | number | string
}

/** What a broadcast returns. */
export interface TransferResult {
  /** Transaction hash (id) on the chain. */
  hash: string
  /** Network fee actually paid or quoted, in native base units. */
  fee: bigint
}

/** The outcome of a mined transaction. */
export interface Receipt {
  /** Transaction hash. */
  hash: string
  /** 1 = succeeded, 0 = reverted / failed. Mirrors the EVM convention modules test against. */
  status: 0 | 1
  /** Block (height, slot) it was included in, when the chain reports one. */
  blockNumber?: bigint
}

/** Network fee rates at three speeds, in the chain's fee unit (gas price in wei, sat/vB…). */
export interface FeeRates {
  /** Rate for a slow, cheap inclusion. */
  slow: bigint
  /** Rate for the usual inclusion time. */
  normal: bigint
  /** Rate for the next block or two. */
  fast: bigint
}

/**
 * Anything that can be read about an address without a key: balances, quotes,
 * receipts. Protocol modules constructed with a read-only account may only quote.
 */
export interface IWalletAccountReadOnly {
  /** CAIP-2 chain id, e.g. "eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "ton:-239", "tron:0x2b6653dc", "bip122:000000000019d6689c085ae165831e93". */
  readonly chain: string
  /** The account's address in the chain's canonical form. */
  getAddress(): Promise<string>
  /** Native balance in base units. */
  getBalance(): Promise<bigint>
  /** Balance of a token (contract, mint, jetton master) in its base units. */
  getTokenBalance(token: string): Promise<bigint>
  /** Network fee the transaction would pay, in native base units. Nothing is signed. */
  quoteSendTransaction(tx: unknown): Promise<{ fee: bigint }>
  /** Network fee a {@link TransferOptions} transfer would pay, in native base units. */
  quoteTransfer(options: TransferOptions): Promise<{ fee: bigint }>
  /** The receipt of a transaction, or `undefined` while it is not yet included. */
  getTransactionReceipt(hash: string): Promise<Receipt | undefined>
  /** Check a message signature against this account's key, the chain's conventional way. */
  verify(message: string | Uint8Array, signature: string): Promise<boolean>
}

/** A read-only account plus the ability to sign and broadcast. */
export interface IWalletAccount extends IWalletAccountReadOnly {
  /**
   * True when `signTransaction` itself needs the network (TON seqno, Solana
   * blockhash, BTC UTXOs, Tron ref block). EVM signs offline.
   */
  readonly needsNetwork: boolean
  /** Sign a message the chain's conventional way (EIP-191, BIP-137, ed25519 raw…). Returns the chain's conventional encoding (hex, base64…). */
  sign(message: string | Uint8Array): Promise<string>
  /** Sign a fully specified transaction WITHOUT broadcasting. Returns the serialised signed tx. */
  signTransaction(tx: unknown): Promise<string>
  /** Sign and broadcast. */
  sendTransaction(tx: unknown): Promise<TransferResult>
  /** Native or token transfer; the account builds the transaction. */
  transfer(options: TransferOptions): Promise<TransferResult>
  /**
   * The same address without signing ability: safe to hand to code that should only read or quote.
   */
  toReadOnlyAccount(): IWalletAccountReadOnly
  /** Zeroize this account's key material. */
  dispose(): void
}

/** Type guard: does this account carry a signer? */
export function canSign(account: IWalletAccountReadOnly): account is IWalletAccount {
  return typeof (account as Partial<IWalletAccount>).sendTransaction === 'function'
}
