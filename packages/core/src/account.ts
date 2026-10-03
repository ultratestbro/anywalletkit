/**
 * The account surface protocol modules are written against. Method names
 * follow the common wallet-account shape, so modules that duck-type the
 * account keep working.
 */

/** A transfer of the chain's native token or of a token on it. Amounts in base units. */
export interface TransferOptions {
  /** Token identifier (contract, mint, jetton master). Omit for the native token. */
  token?: string
  recipient: string
  amount: bigint | number | string
}

export interface TransferResult {
  hash: string
  /** Network fee actually paid or quoted, in native base units. */
  fee: bigint
}

export interface Receipt {
  hash: string
  /** 1 = succeeded, 0 = reverted / failed. Mirrors the EVM convention modules test against. */
  status: 0 | 1
  blockNumber?: bigint
}

export interface FeeRates {
  slow: bigint
  normal: bigint
  fast: bigint
}

/**
 * Anything that can be read about an address without a key: balances, quotes,
 * receipts. Protocol modules constructed with a read-only account may only quote.
 */
export interface IWalletAccountReadOnly {
  /** CAIP-2 chain id, e.g. "eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "ton:-239", "tron:0x2b6653dc", "bip122:000000000019d6689c085ae165831e93". */
  readonly chain: string
  getAddress(): Promise<string>
  getBalance(): Promise<bigint>
  getTokenBalance(token: string): Promise<bigint>
  quoteSendTransaction(tx: unknown): Promise<{ fee: bigint }>
  quoteTransfer(options: TransferOptions): Promise<{ fee: bigint }>
  getTransactionReceipt(hash: string): Promise<Receipt | undefined>
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
  toReadOnlyAccount(): IWalletAccountReadOnly
  /** Zeroize this account's key material. */
  dispose(): void
}

/** Type guard: does this account carry a signer? */
export function canSign(account: IWalletAccountReadOnly): account is IWalletAccount {
  return typeof (account as Partial<IWalletAccount>).sendTransaction === 'function'
}
