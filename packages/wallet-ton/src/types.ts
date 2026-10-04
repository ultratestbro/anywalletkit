import type { Cell, TonClient } from '@ton/ton'

/** A toncenter v2 endpoint (api keys there are meant for client-side wallets). */
export interface TonEndpoint { url: string; secretKey?: string }

export interface TonConfig {
  /** toncenter endpoint(s) or TonClient(s). A list fails over in order. Omit for an offline (sign-only) wallet. */
  tonClient?: TonEndpoint | TonClient | Array<TonEndpoint | TonClient>
  /** Alias of `tonClient`. */
  provider?: TonEndpoint | TonClient | Array<TonEndpoint | TonClient>
  /** Extra rounds across the endpoint list after the first full pass (default 3). */
  retries?: number
  /** Max fee (nanotons) for `transfer`. */
  transferMaxFee?: bigint | number
  /** Max fee (nanotons) for `sendTransaction` / `signTransaction`. */
  transactionMaxFee?: bigint | number
  /** toncenter v3 base used for receipts (default https://toncenter.com/api/v3). */
  indexerUrl?: string
  /** tonapi base used for fee rates (default https://tonapi.io/v2). */
  tonApiUrl?: string
  /** 'mainnet' (ton:-239, default) or 'testnet' (ton:-3). */
  network?: 'mainnet' | 'testnet'
}

/** A TON transfer. `value` in nanotons. `body`: text comment or a Cell. */
export interface TonTransaction {
  to: string
  value: bigint | number | string
  bounceable?: boolean
  body?: string | Cell
}

/** `sendTransaction` also accepts an already built (signed) external-message body Cell. */
export type TonSendable = TonTransaction | Cell

export interface TonTransferOptions {
  /** Jetton master address. Omit for native TON. */
  token?: string
  recipient: string
  amount: bigint | number | string
}

export interface TonReceipt {
  /** The body hash that was returned by sendTransaction. */
  hash: string
  /** 1 when the wallet transaction completed without abort, 0 otherwise. */
  status: 0 | 1
  /** Logical time of the account transaction. */
  blockNumber: bigint
  /** Account transaction hash (base64). */
  transactionHash: string
  totalFees: bigint
  /** The raw @ton/core Transaction. */
  raw: unknown
}

export const CAIP2: Record<'mainnet' | 'testnet', string> = { mainnet: 'ton:-239', testnet: 'ton:-3' }
