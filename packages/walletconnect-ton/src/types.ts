/**
 * The WalletKit (Reown) objects this package reads, described structurally: the package has no
 * WalletConnect runtime dependency, the app brings WalletKit and hands its plain objects in.
 */
import type {
  TonConnectSendTransaction, TonDescription, TonProof, TonProofRequest, TonSignDataPayload, TonSignDataRequest,
  TonSignedData, TonSimulation, TonTransaction,
} from '@anywalletkit/wallet-ton'

/** A peer's metadata (`session.peer.metadata`, `proposal.params.proposer.metadata`). */
export interface WcPeerMetadata {
  name?: string
  url?: string
  icons?: string[]
  description?: string
}

/** One namespace of a proposal (`requiredNamespaces` / `optionalNamespaces`). */
export interface WcProposalNamespace {
  chains?: string[]
  methods?: string[]
  events?: string[]
}

/** A CAIP-122 authentication request carried by a session proposal (`params.requests.authentication`). */
export interface WcAuthenticateParams {
  domain?: string
  chains?: string[]
  nonce?: string
  /** `ton_proof` for a TON Connect proof (`@tonconnect/sdk` puts it in the request's `uri`, which arrives as `aud`). */
  aud?: string
  version?: string
  type?: string
  iat?: string
  /** The dApp's `ton_proof` payload. */
  statement?: string
}

/** The proposal fields read here: WalletKit's `session_proposal` event, or its `params`. */
export interface WcProposalLike {
  id?: number
  params?: WcProposalParams
  proposer?: { metadata?: WcPeerMetadata }
  requiredNamespaces?: Record<string, WcProposalNamespace>
  optionalNamespaces?: Record<string, WcProposalNamespace>
  requests?: { authentication?: WcAuthenticateParams[] }
}

export interface WcProposalParams {
  proposer?: { metadata?: WcPeerMetadata }
  requiredNamespaces?: Record<string, WcProposalNamespace>
  optionalNamespaces?: Record<string, WcProposalNamespace>
  requests?: { authentication?: WcAuthenticateParams[] }
}

/** The session fields read here (WalletKit `getActiveSessions()[topic]`). */
export interface WcSessionLike {
  topic?: string
  peer?: { metadata?: WcPeerMetadata }
  namespaces?: Record<string, { chains?: string[]; accounts?: string[]; methods?: string[]; events?: string[] }>
}

/** WalletKit's `session_request` event, or the same shape built by the app. */
export interface WcSessionRequestLike {
  id: number
  topic?: string
  params: { chainId: string; request: { method: string; params?: unknown } }
}

/** The `ton` namespace a session is approved with. */
export interface TonSessionNamespace {
  chains: string[]
  methods: string[]
  events: string[]
  /** `ton:-239:<user-friendly address>`. */
  accounts: string[]
}

/** The two session properties `@tonconnect/sdk` requires of a TON session. */
export interface TonSessionProperties {
  /** The wallet's ed25519 public key, hex. */
  ton_getPublicKey: string
  /** The wallet's V5R1 StateInit, base64 BoC. */
  ton_getStateInit: string
}

/**
 * The CAIP-122 object a `ton_proof` is answered with (`proposalRequestsResponses.authentication`).
 * `@tonconnect/sdk` reads `p.domain`, `p.iat`, `p.statement` and `s.s` (the base64 ed25519 signature).
 */
export interface TonCacao {
  h: { t: 'caip122' }
  p: { domain: string; aud: string; version: string; nonce: string; iat: string; statement: string; iss: string }
  s: { t: 'ton_proof'; s: string }
}

/** What the review step needs of an account: the address, the key, an offline description and (optionally) an emulation. */
export interface TonWcAccount {
  /** `ton:-239` (mainnet) or `ton:-3` (testnet). */
  readonly chain: string
  /** User-friendly address (raw is accepted too). */
  readonly address: string
  /** 32-byte ed25519 public key. */
  readonly publicKey: Uint8Array
  describe?(tx: TonTransaction[]): TonDescription
  simulateTransaction?(tx: TonTransaction[]): Promise<TonSimulation>
}

/** A signing account: `WalletAccountTon` (from wallet-ton), raw or wrapped by `applyPolicies`. */
export interface TonWcSigningAccount extends TonWcAccount {
  sendTransaction(tx: TonTransaction[]): Promise<{ hash: string; fee: bigint; boc?: string }>
  signTonConnectData(request: TonSignDataRequest): Promise<TonSignedData>
  signTonProof(request: TonProofRequest): Promise<TonProof>
}

/**
 * Opens the signing account for one call, after the review said yes, and closes it after (the
 * keyring's `withAccount`). Use it when the key should be read only once the user confirmed;
 * otherwise pass a signing account as `account`.
 */
export type TonWithSigner = <T>(run: (account: TonWcSigningAccount) => Promise<T>) => Promise<T>

/** What the review callback is shown for `ton_sendMessage`. */
export interface TonSendMessageReview {
  method: 'ton_sendMessage'
  /** The network the request is for (`ton:-239`). */
  chain: string
  /** The dApp's host, from the session's peer metadata (or `options.peerDomain`). */
  peerDomain?: string
  /** The request as parsed and checked. */
  request: TonConnectSendTransaction
  /** The messages as the account will send them (`value` in nanotons). */
  transactions: TonTransaction[]
  /** The account's offline description of the messages (kinds, jetton transfers, warnings), when it can give one. */
  description?: TonDescription
  /** The account's preflight emulation, run on demand (one network round trip). */
  simulate?: () => Promise<TonSimulation>
}

/** What the review callback is shown for `ton_signData`. */
export interface TonSignDataReview {
  method: 'ton_signData'
  chain: string
  /** The domain the signature binds to: the peer's host, never the request's claim. */
  peerDomain: string
  payload: TonSignDataPayload
}

export type TonRequestReview = TonSendMessageReview | TonSignDataReview

export interface HandleTonRequestOptions {
  /** The session the request came on: its peer metadata gives the domain, its `ton` accounts and chains must hold this account. */
  session?: WcSessionLike
  /**
   * The dApp's host, overriding the session's peer metadata — pass WalletKit's verified origin
   * (`verifyContext.verified.origin`, host part) when its validation is `VALID`.
   */
  peerDomain?: string
  /** Show the request to the user; `true` signs, `false` declines (300). Nothing is signed before it resolves `true`. */
  review: (request: TonRequestReview) => boolean | Promise<boolean>
  /** Aborts before review or before signing (an expired WalletConnect request, a closed sheet). */
  signal?: AbortSignal
  /** Opens the signing account after the review (see {@link TonWithSigner}); without it `account` must sign. */
  withSigner?: TonWithSigner
  /** Unix seconds now (tests). */
  now?: () => number
  /** Most messages per request (default and maximum 4: `@tonconnect/sdk` assumes 4 for WalletConnect wallets). */
  maxMessages?: number
}

/** A JSON-RPC response for WalletKit's `respondSessionRequest({ topic, response })`. */
export type TonRpcResponse =
  | { id: number; jsonrpc: '2.0'; result: unknown }
  | { id: number; jsonrpc: '2.0'; error: { code: number; message: string } }
