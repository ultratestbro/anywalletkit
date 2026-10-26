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
 * A fact about a token that matters to whoever holds it, read from the chain:
 * - `upgradeable`: an EVM proxy (EIP-1967 / EIP-1822 / beacon); its owner can replace the code.
 * - `mint-authority`: someone can still mint more (Solana).
 * - `freeze-authority`: someone can freeze holders' token accounts (Solana).
 * - `permanent-delegate`: someone can move or burn anyone's balance (Token-2022).
 * - `transfer-fee`: every transfer pays a fee to the mint (Token-2022).
 * - `transfer-hook`: a program of the mint's choosing runs on every transfer (Token-2022).
 * - `non-transferable`: holders cannot move it (Token-2022).
 * - `default-frozen`: new token accounts start frozen (Token-2022).
 * - `pausable`: someone can pause every transfer (Token-2022).
 */
export type TokenFlag =
  | 'upgradeable'
  | 'mint-authority'
  | 'freeze-authority'
  | 'permanent-delegate'
  | 'transfer-fee'
  | 'transfer-hook'
  | 'non-transferable'
  | 'default-frozen'
  | 'pausable'

/**
 * What a chain package reads about a token from the chain itself, never from a list. `symbol` and
 * `name` are whatever the token says about itself: anyone can deploy a token called "USDC", so
 * they never identify it — the address does.
 */
export interface TokenInfo {
  /** The token's address (contract, mint) in the chain's canonical form. */
  address: string
  /** `erc20`, `spl` or `spl-token-2022`. */
  standard: string
  /** Base-unit decimals. */
  decimals: number
  /** As the token reports it (may be empty). */
  symbol: string
  /** As the token reports it (may be empty). */
  name: string
  /** Total supply in base units, when the token reports it. */
  totalSupply?: bigint
  /** Holder-relevant facts read from the chain; empty when none apply. */
  flags: TokenFlag[]
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
  /**
   * Decimals, symbol, name, supply and holder-relevant {@link TokenFlag}s of a token, read from the
   * chain. Throws {@link NotATokenError} when the address is not a token there. Chain packages that
   * cannot read token metadata leave it out.
   */
  getTokenInfo?(token: string): Promise<TokenInfo>
  /** Network fee the transaction would pay, in native base units. Nothing is signed. */
  quoteSendTransaction(tx: unknown): Promise<{ fee: bigint }>
  /** Network fee a {@link TransferOptions} transfer would pay, in native base units. */
  quoteTransfer(options: TransferOptions): Promise<{ fee: bigint }>
  /** The receipt of a transaction, or `undefined` while it is not yet included. */
  getTransactionReceipt(hash: string): Promise<Receipt | undefined>
  /** Check a message signature against this account's key, the chain's conventional way. */
  verify(message: string | Uint8Array, signature: string): Promise<boolean>
}

/** Per-call limits of one write, on top of the account's own configuration. */
export interface WriteOptions {
  /**
   * Cap on this write's worst-case network fee, in native base units. Checked by the chain
   * package on the transaction it is about to sign (EVM: its gas limit × its own gas price), with
   * the tighter of this and the account's configured cap winning. The kit's `policies.maxFee`
   * passes it down.
   */
  maxFee?: bigint
}

/** The tighter of an account's configured fee cap and a per-call {@link WriteOptions.maxFee}. */
export function feeLimit(configured: bigint | number | undefined, options?: WriteOptions): bigint | undefined {
  const limits = [configured, options?.maxFee].filter((l): l is bigint | number => l !== undefined).map((l) => BigInt(l))
  return limits.length === 0 ? undefined : limits.reduce((a, b) => (b < a ? b : a))
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
  signTransaction(tx: unknown, options?: WriteOptions): Promise<string>
  /** Sign and broadcast. */
  sendTransaction(tx: unknown, options?: WriteOptions): Promise<TransferResult>
  /** Native or token transfer; the account builds the transaction. */
  transfer(options: TransferOptions, writeOptions?: WriteOptions): Promise<TransferResult>
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
