import type { Cell, StateInit } from '@ton/core'

/** A toncenter v2 JSON-RPC endpoint (api keys there are meant for client-side wallets). */
export interface TonEndpoint { url: string; secretKey?: string }

/** Anything that can answer a toncenter v2 JSON-RPC call (an endpoint wrapper, a test double, a proxy). */
export interface TonRpc {
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>
}

export type TonProvider = TonEndpoint | TonRpc

export interface TonConfig {
  /** toncenter endpoint(s) or `TonRpc`(s). A list fails over in order. Omit for an offline (sign-only) wallet. */
  tonClient?: TonProvider | TonProvider[]
  /** Alias of `tonClient`. */
  provider?: TonProvider | TonProvider[]
  /** Extra rounds across the endpoint list after the first full pass (default 3). */
  retries?: number
  /** Per-request timeout in ms (default 15 000). */
  timeoutMs?: number
  /** Injectable fetch (tests, custom agents). Defaults to globalThis.fetch. */
  fetch?: typeof fetch
  /** Max fee (nanotons) for `transfer`. */
  transferMaxFee?: bigint | number
  /** Max fee (nanotons) for `sendTransaction` / `signTransaction`. */
  transactionMaxFee?: bigint | number
  /** toncenter v3 base used for receipts (default https://toncenter.com/api/v3). */
  indexerUrl?: string
  /** tonapi base used for fee rates and (by default) emulation (default https://tonapi.io/v2). */
  tonApiUrl?: string
  /** tonapi bearer key (sent as `Authorization: Bearer …`); also sent as X-API-Key to a toncenter-v3 emulator. */
  tonApiKey?: string
  /**
   * Preflight emulation of every send (zero-signed external). Default
   * `{kind: 'tonapi'}`: `POST {tonApiUrl}/wallet/emulate` (verdict + `risk`),
   * falling back to `/traces/emulate`. `{kind: 'toncenter-v3', url}` posts to a
   * toncenter `emulateTrace` endpoint instead. `false` = `estimateFee` only.
   * A non-zero compute exit, an aborted transaction, a failed action phase or a
   * failed FIRST-HOP internal message throws `SimulationError` before signing.
   */
  emulate?: TonEmulateConfig
  /** @deprecated Use `emulate: {kind: 'toncenter-v3', url}`. Still honoured when `emulate` is unset. */
  emulateUrl?: string
  /**
   * Allow a body whose emulated `risk.transfer_all_remaining_balance` is true
   * (send mode 128 / CARRY_ALL_BALANCE). Refused by default — nothing this
   * wallet builds does that, so it only ever comes from a foreign `bodyBoc`.
   */
  allowDrainingTransactions?: boolean
  /** Run the preflight (estimateFee + emulation when configured) before signing. Default true. */
  simulate?: boolean
  /** Seconds a signed external stays valid (default 60, max 600). */
  validUntilSeconds?: number
  /** Nanotons attached to a jetton transfer on top of `forwardTonAmount` (default 0.05 TON). */
  jettonAttachedValue?: bigint | number | string
  /**
   * 'mainnet' (ton:-239, default) or 'testnet' (ton:-3). Sets the CAIP-2 id, the address flags and the
   * wallet_id network (-239 / -3), so a testnet wallet has its own address and its signed messages are
   * not valid on mainnet (as in Tonkeeper and @ton/ton).
   */
  network?: 'mainnet' | 'testnet'
  /**
   * V5R1 wallet_id parts. Defaults (network id from `network`, subwallet 0) give the
   * addresses Tonkeeper and Tonhub derive for a key; change the subwallet only to
   * reach a wallet that was created with a different one. A networkGlobalId that
   * contradicts `network` is refused.
   */
  walletId?: { networkGlobalId?: number; subwalletNumber?: number }
}

/** One internal message. `value` in nanotons. `body`: text comment or a Cell; `bodyBoc`: the same as base64 BoC. */
export interface TonTransaction {
  to: string
  value: bigint | number | string
  /** Defaults to the flag in a friendly address (EQ… bounceable, UQ… not); raw addresses default to bounceable. */
  bounceable?: boolean
  body?: string | Cell
  /** Prebuilt message body as base64 BoC (e.g. an Omniston escrow payload). Ignored when `body` is set. */
  bodyBoc?: string
  /** StateInit to attach (deploys the destination): `{code, data}`, a StateInit cell, or its base64 BoC. */
  stateInit?: StateInit | Cell | string
  /** Send mode for this message (default PAY_GAS_SEPARATELY; IGNORE_ERRORS is always OR-ed in for externals). */
  sendMode?: number
}

/**
 * What `sendTransaction` / `signTransaction` accept: one message, several
 * messages in ONE external (up to 255 — swaps need it), or an already signed
 * V5R1 external-message body Cell.
 */
export type TonSendable = TonTransaction | TonTransaction[] | Cell

export interface TonTransferOptions {
  /** Jetton master address. Omit for native TON. */
  token?: string
  recipient: string
  amount: bigint | number | string
  /** Jetton only: nanotons forwarded to the recipient with the transfer notification (default 1). */
  forwardTonAmount?: bigint | number | string
  /** Jetton only: forward payload — a text comment or a Cell (DEX / escrow payloads). */
  forwardPayload?: Cell | string
  /**
   * Text memo (a deposit memo, an exchange tag). Jetton: sent as the forward-payload comment (TEP-74);
   * native TON: the message comment. Cannot be combined with `forwardPayload`.
   */
  memo?: string
  /** Jetton only: custom payload cell (rarely needed; e.g. mintless jettons). */
  customPayload?: Cell
  /** Jetton only: where excess TON returns (default: this wallet). */
  responseDestination?: string
  /** Jetton only: query id (default random). */
  queryId?: bigint | number
  /** Jetton only: nanotons attached to the jetton-wallet call (default config.jettonAttachedValue + forwardTonAmount). */
  attachedValue?: bigint | number | string
}

/** toncenter `estimateFee` source fees, nanotons. */
export interface TonFees {
  inFwdFee: bigint
  storageFee: bigint
  gasFee: bigint
  fwdFee: bigint
  /** Sum of the four. */
  total: bigint
}

export type TonEmulateConfig =
  | { kind: 'tonapi'; url?: string }
  | { kind: 'toncenter-v3'; url: string }
  | false

/** What a message would move out of the wallet, per tonapi's `risk`. */
export interface TonRisk {
  /** Nanotons leaving the wallet (value + fees the emulator attributes). */
  ton: bigint
  jettons: Array<{ address: string; walletAddress: string; amount: bigint; symbol?: string; decimals?: number }>
  /** Send mode 128: the whole remaining balance goes with the message. */
  transferAllRemainingBalance: boolean
}

export type TonSimulationSource = 'tonapi' | 'toncenter-v3' | 'estimate-only'

export type TonSimulation =
  | { ok: true; fees: TonFees; emulated: boolean; source: TonSimulationSource; exitCode?: number; actionSuccess?: boolean; risk?: TonRisk; warnings: string[] }
  | { ok: false; fees?: TonFees; emulated: true; source: Exclude<TonSimulationSource, 'estimate-only'>; reason: string; exitCode?: number; aborted?: boolean; risk?: TonRisk; warnings: string[] }

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
