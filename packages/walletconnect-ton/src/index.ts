/**
 * WalletConnect for TON: what a wallet built on Any Wallet Kit answers in the `ton` namespace so
 * TON dApps that offer WalletConnect (`@tonconnect/sdk` ≥ 3.4 `initializeWalletConnect`) connect to
 * it without a listing in the TON wallets registry. Bring Reown WalletKit; hand its objects in.
 */
export {
  TON_WC_METHODS, TON_WC_EVENTS, TON_WC_CHAINS, TON_PROOF_PAYLOAD_MAX,
  tonSessionNamespace, tonSessionProperties, tonSessionAddress, tonProposalChains, tonProofAuthentication, tonProofRequest, tonNetworkOf, peerHost,
} from './session.js'
export { handleTonRequest, tonErrorResponse, tonConnectTransactions, TonRequestError } from './requests.js'
export { TONCONNECT_ERRORS, TONCONNECT_MAX_MESSAGES } from '@anywalletkit/wallet-ton/tonconnect'
export type * from './types.js'
