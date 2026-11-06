/**
 * Session approval for the `ton` namespace (Reown "TON RPC reference", and what `@tonconnect/sdk`
 * 5.x `WalletConnectProvider` reads on connect):
 *
 *   namespace  `ton`, chains `ton:-239` (mainnet) / `ton:-3` (testnet), no events
 *   methods    `ton_sendMessage`, `ton_signData`
 *   account    `ton:-239:<user-friendly address>` — the dApp splits the CAIP-10 id on its first
 *              two colons, so a raw `0:…` address would be cut to `0`
 *   properties `ton_getPublicKey` (hex) and `ton_getStateInit` (base64 BoC of the V5R1 StateInit):
 *              without them the dApp drops the session
 *   ton_proof  asked through the proposal's CAIP-122 `requests.authentication` (`aud: ton_proof`,
 *              the payload in `statement`), answered in `proposalRequestsResponses.authentication`
 */
import { beginCell, storeStateInit } from '@ton/core'
import { v5r1Address, v5r1StateInit, v5r1WalletId, MAINNET_GLOBAL_ID, TESTNET_GLOBAL_ID } from '@anywalletkit/wallet-ton'
import { TONCONNECT_ERRORS, TonConnectError, sameTonConnectAddress, tonConnectFriendlyAddress, tonConnectRawAddress } from '@anywalletkit/wallet-ton/tonconnect'
import type { TonCacao, TonSessionNamespace, TonSessionProperties, TonWcAccount, TonWcSigningAccount, TonWithSigner, WcAuthenticateParams, WcProposalLike, WcProposalParams } from './types.js'

/** The methods a TON session serves. */
export const TON_WC_METHODS = ['ton_sendMessage', 'ton_signData'] as const
/** TON sessions carry no events. */
export const TON_WC_EVENTS: readonly string[] = []
/** The two TON networks as WalletConnect chains. */
export const TON_WC_CHAINS = { mainnet: 'ton:-239', testnet: 'ton:-3' } as const

const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

/** `ton:-239` → `-239`; anything that is not a TON chain → undefined. */
export function tonNetworkOf(chain: string): '-239' | '-3' | undefined {
  return chain === TON_WC_CHAINS.mainnet ? '-239' : chain === TON_WC_CHAINS.testnet ? '-3' : undefined
}

function accountNetwork(account: TonWcAccount): '-239' | '-3' {
  const n = tonNetworkOf(account.chain)
  if (!n) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, `Not a TON account (chain ${account.chain}).`)
  return n
}

/** The account's address as WalletConnect carries it: user-friendly, url-safe, non-bounceable (test-only on testnet). */
export function tonSessionAddress(account: TonWcAccount): string {
  const friendly = tonConnectFriendlyAddress(account.address, { testOnly: accountNetwork(account) === '-3' })
  if (!friendly) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, `Not a TON address: ${account.address}`)
  return friendly
}

/** The TON chains a proposal asks for, required and optional, in both namespace forms (`ton: {chains}` and `"ton:-239": {}`). */
export function tonProposalChains(proposal: WcProposalLike): { required: string[]; optional: string[] } {
  const p = proposalParams(proposal)
  const collect = (nss: WcProposalParams['requiredNamespaces']) => {
    const out = new Set<string>()
    for (const [key, ns] of Object.entries(nss ?? {})) {
      if (key === 'ton') { for (const c of ns?.chains ?? []) out.add(c); if (!ns?.chains?.length) out.add('ton') }
      else if (key.startsWith('ton:')) out.add(key)
    }
    return [...out]
  }
  return { required: collect(p.requiredNamespaces), optional: collect(p.optionalNamespaces) }
}

/**
 * The `ton` namespace for `approveSession`, on the account's own network. `chains` are the TON
 * chains the proposal asked for (see {@link tonProposalChains}); when they do not include the
 * account's network the result is `undefined` and TON is left out of the session (reject the
 * proposal if TON was required). Omit `chains` to approve the account's network as is.
 */
export function tonSessionNamespace(account: TonWcAccount, options: { chains?: readonly string[] } = {}): TonSessionNamespace | undefined {
  accountNetwork(account)
  const asked = (options.chains ?? []).filter((c) => c !== 'ton')
  if (asked.length > 0 && !asked.includes(account.chain)) return undefined
  return { chains: [account.chain], methods: [...TON_WC_METHODS], events: [...TON_WC_EVENTS], accounts: [`${account.chain}:${tonSessionAddress(account)}`] }
}

/**
 * `sessionProperties` for `approveSession`: the public key (hex) and the V5R1 StateInit (base64
 * BoC). Needs no key and no network: both derive from the public key. The StateInit is checked to
 * derive the account's own address (a wallet on a non-default subwallet id is refused).
 */
export function tonSessionProperties(account: TonWcAccount): TonSessionProperties {
  const network = accountNetwork(account)
  if (!(account.publicKey instanceof Uint8Array) || account.publicKey.length !== 32) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'A TON account needs its 32-byte public key.')
  const walletId = v5r1WalletId({ networkGlobalId: network === '-3' ? TESTNET_GLOBAL_ID : MAINNET_GLOBAL_ID })
  const init = v5r1StateInit(account.publicKey, walletId)
  const derived = v5r1Address(account.publicKey, { walletId }).toRawString()
  if (tonConnectRawAddress(account.address) !== derived) {
    throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'The account is not the standard V5R1 wallet of its public key (another subwallet id?); its StateInit cannot be given.')
  }
  return {
    ton_getPublicKey: hex(account.publicKey),
    ton_getStateInit: beginCell().store(storeStateInit(init)).endCell().toBoc().toString('base64'),
  }
}

function proposalParams(proposal: WcProposalLike): WcProposalParams {
  return proposal.params && typeof proposal.params === 'object' ? proposal.params : proposal
}

/**
 * The host of a peer URL (`https://app.ston.fi/swap` → `app.ston.fi`), lowercase, without port, or
 * undefined. http(s) only. By hand, not `new URL`: it must not depend on the runtime's URL polyfill.
 */
export function peerHost(url: string | undefined): string | undefined {
  if (typeof url !== 'string') return undefined
  const m = /^https?:\/\/(?:[^@/?#]*@)?(\[[0-9a-fA-F:.]+\]|[^:/?#\s]+)(?::\d{1,5})?(?:[/?#]|$)/i.exec(url.trim())
  return m ? m[1]!.toLowerCase() : undefined
}

/** The `ton_proof` request of a proposal, if it carries one. */
export function tonProofRequest(proposal: WcProposalLike): WcAuthenticateParams | undefined {
  const list = proposalParams(proposal).requests?.authentication
  if (!Array.isArray(list)) return undefined
  return list.find((a) => a?.aud === 'ton_proof')
}

/** Longest `ton_proof` payload signed (characters). */
export const TON_PROOF_PAYLOAD_MAX = 512

/**
 * Answer a proposal's `ton_proof` (call it once the user approved the session, then pass the result
 * as `proposalRequestsResponses: { authentication }` to `approveSession`). Returns `undefined` when
 * the proposal asks for no proof. The proof binds to `peerDomain`, or to the host of the proposer's
 * metadata URL, never to the domain written in the request; the timestamp is the wallet's clock.
 */
export async function tonProofAuthentication(
  account: TonWcAccount | TonWcSigningAccount,
  proposal: WcProposalLike,
  options: { peerDomain?: string; withSigner?: TonWithSigner; now?: () => number } = {},
): Promise<TonCacao[] | undefined> {
  const auth = tonProofRequest(proposal)
  if (!auth) return undefined
  accountNetwork(account)
  const domain = options.peerDomain ?? peerHost(proposalParams(proposal).proposer?.metadata?.url)
  if (!domain) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, "The dApp's domain is unknown, so ton_proof cannot be bound to it.")
  const payload = typeof auth.statement === 'string' ? auth.statement : ''
  if (payload.length > TON_PROOF_PAYLOAD_MAX) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'The ton_proof payload is too long.')
  const timestamp = options.now ? options.now() : Math.floor(Date.now() / 1000)
  const sign = (a: TonWcSigningAccount) => {
    if (!sameTonConnectAddress(a.address, account.address)) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'The signing account is not the account the session is for.')
    return a.signTonProof({ domain, timestamp, payload })
  }
  const proof = options.withSigner ? await options.withSigner(sign) : await sign(requireSigning(account))
  return [{
    h: { t: 'caip122' },
    p: {
      domain, aud: 'ton_proof', version: '1', nonce: typeof auth.nonce === 'string' ? auth.nonce : '',
      iat: new Date(timestamp * 1000).toISOString(), statement: payload, iss: `did:pkh:${account.chain}:${tonSessionAddress(account)}`,
    },
    s: { t: 'ton_proof', s: proof.signature },
  }]
}

/** The account itself when it can sign; otherwise a refusal (the app passes `withSigner` instead). */
export function requireSigning(account: TonWcAccount | TonWcSigningAccount): TonWcSigningAccount {
  const a = account as Partial<TonWcSigningAccount>
  if (typeof a.sendTransaction !== 'function' || typeof a.signTonConnectData !== 'function' || typeof a.signTonProof !== 'function') {
    throw new TonConnectError(TONCONNECT_ERRORS.unknown, 'This account cannot sign: pass a signing account or withSigner.')
  }
  return account as TonWcSigningAccount
}
