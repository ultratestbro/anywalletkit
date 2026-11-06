/**
 * `ton_sendMessage` and `ton_signData` session requests → a wallet-ton account, and back as the
 * JSON-RPC response WalletKit sends.
 *
 * Every request: the network and the session's account are checked, the payload is parsed by the
 * shared TON Connect parser (`@anywalletkit/wallet-ton/tonconnect`, the same one the extension's
 * JS bridge uses), the app's `review` is shown, and only a `true` leads to one signing call:
 *
 *   ton_sendMessage  `account.sendTransaction(messages)`: policies (when the account is wrapped by
 *                    `applyPolicies`), the account's own checks (drain modes 128 / 32, balance,
 *                    preflight emulation, fee cap), ONE signature, the broadcast of those bytes;
 *                    the reply is the external message exactly as broadcast (base64 BoC)
 *   ton_signData     `account.signTonConnectData`: text / binary bound to the peer's domain
 *
 * Errors carry TON Connect codes (300 declined, 1 bad request, 400 not supported, 0 unknown). The
 * dApp side (`@tonconnect/sdk` 5.x `WalletConnectProvider`) ignores the code and maps a wallet error
 * by its message text: "reject" → 300, "TonValidationError" → 1, anything else → 0. Messages are
 * written to land in the right bucket.
 */
import { Cell, loadStateInit } from '@ton/core'
import {
  TONCONNECT_ERRORS, TONCONNECT_MAX_MESSAGES, isTonConnectBase64, parseSendTransaction, parseSignData, sameTonConnectAddress, tonConnectRawAddress,
  type TonConnectMessage,
} from '@anywalletkit/wallet-ton/tonconnect'
import type { TonTransaction } from '@anywalletkit/wallet-ton'
import { peerHost, requireSigning, tonNetworkOf } from './session.js'
import type { HandleTonRequestOptions, TonRpcResponse, TonWcAccount, TonWcSigningAccount, WcSessionLike, WcSessionRequestLike } from './types.js'

/** A refusal with its TON Connect code, as {@link handleTonRequest} answers it. */
export class TonRequestError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'TonRequestError' }
}

const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')
const bad = (message: string) => new TonRequestError(TONCONNECT_ERRORS.badRequest, message)

/** A thrown TON Connect refusal (either class, across module copies) → its code. */
function codeOf(e: unknown): number | undefined {
  const err = e as { name?: unknown; code?: unknown } | null
  if (err && (err.name === 'TonConnectError' || err.name === 'TonRequestError') && typeof err.code === 'number') return err.code
  return undefined
}

/** The message text the dApp side maps back to `code` (see the module comment). */
function wireMessage(code: number, message: string): string {
  if (code === TONCONNECT_ERRORS.userDeclined) return /reject/i.test(message) ? message : `User rejected the request: ${message}`
  // Anything else must not read as a user decline, nor (unless it is one) as a bad request.
  const clean = message.replace(/reject/gi, 'refuse').replace(/tonvalidationerror/gi, 'validation error').slice(0, 300)
  return code === TONCONNECT_ERRORS.badRequest ? `TonValidationError: ${clean}` : clean
}

/** Any failure → the error response. A user or policy decline is 300; a maybe-sent broadcast says so. */
export function tonErrorResponse(id: number, e: unknown): TonRpcResponse {
  let code = codeOf(e)
  let message = e instanceof Error ? e.message : String(e)
  const err = e as { name?: unknown; code?: unknown; maybeSent?: unknown } | null
  if (code === undefined) {
    if (err?.name === 'UserRejectedError' || err?.code === 4001) { code = TONCONNECT_ERRORS.userDeclined; message = 'The user declined.' }
    else if (err?.maybeSent === true) { code = TONCONNECT_ERRORS.unknown; message = 'The network did not confirm the transaction; it may still be included. Check the wallet activity before sending again.' }
    else code = TONCONNECT_ERRORS.unknown
  }
  return { id, jsonrpc: '2.0', error: { code, message: wireMessage(code, message) } }
}

/** The Reown spec sends `[params]`; `@tonconnect/sdk` and AppKit send the object itself. */
const firstParam = (params: unknown): unknown => (Array.isArray(params) ? params[0] : params)

/**
 * TON Connect messages → wallet-ton transactions, each address and BoC checked: a raw `wc:hex`
 * or a friendly address with its checksum, a body that decodes as a cell, a StateInit that decodes
 * as one. A zero amount is not sent by the wallet and is refused here, before the review.
 */
export function tonConnectTransactions(messages: TonConnectMessage[]): TonTransaction[] {
  return messages.map((m, i) => {
    const n = i + 1
    if (tonConnectRawAddress(m.address) === null) throw bad(`Message ${n} address is not a TON address.`)
    if (!/^[0-9]+$/.test(m.amount) || BigInt(m.amount) === 0n) throw new TonRequestError(TONCONNECT_ERRORS.methodNotSupported, `Message ${n} carries no nanotons; this wallet does not send zero-value messages.`)
    if (m.payload !== undefined) {
      if (!isTonConnectBase64(m.payload)) throw bad(`Message ${n} payload is not base64.`)
      try { Cell.fromBase64(m.payload) } catch { throw bad(`Message ${n} payload is not a BoC.`) }
    }
    if (m.stateInit !== undefined) {
      if (!isTonConnectBase64(m.stateInit)) throw bad(`Message ${n} stateInit is not base64.`)
      let whole = false
      try {
        const slice = Cell.fromBase64(m.stateInit).beginParse()
        loadStateInit(slice)
        whole = slice.remainingBits === 0 && slice.remainingRefs === 0
      } catch { whole = false }
      if (!whole) throw bad(`Message ${n} stateInit is not a StateInit BoC.`)
    }
    return { to: m.address, value: BigInt(m.amount), ...(m.payload !== undefined ? { bodyBoc: m.payload } : {}), ...(m.stateInit !== undefined ? { stateInit: m.stateInit } : {}) }
  })
}

/** The session's `ton` account must be this account, on the request's chain. */
function checkSession(session: WcSessionLike | undefined, account: TonWcAccount, chainId: string): void {
  if (!session) return
  const ns = session.namespaces?.ton
  if (!ns) throw bad('This session has no TON namespace.')
  const chains = new Set([...(ns.chains ?? []), ...(ns.accounts ?? []).map((a) => a.split(':', 2).join(':'))])
  if (!chains.has(chainId)) throw bad(`This session is not approved for ${chainId}.`)
  const held = (ns.accounts ?? []).filter((a) => a.startsWith(`${chainId}:`)).map((a) => a.slice(chainId.length + 1))
  if (!held.some((addr) => sameTonConnectAddress(addr, account.address))) throw bad('This session is for another TON account.')
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TonRequestError(TONCONNECT_ERRORS.userDeclined, 'The request was cancelled (rejected before signing).')
}

/**
 * Answer one WalletConnect `session_request` on the `ton` namespace. Resolves to the JSON-RPC
 * response to send (`walletKit.respondSessionRequest({ topic, response })`); it does not throw for a
 * refused or failed request.
 *
 * `account` is the session's account: a signing `WalletAccountTon` (wrap it with `applyPolicies` so
 * the app's policies run), or a read-only one plus `options.withSigner`, which opens the signing
 * account only after the review said yes.
 */
export async function handleTonRequest(account: TonWcAccount | TonWcSigningAccount, request: WcSessionRequestLike, options: HandleTonRequestOptions): Promise<TonRpcResponse> {
  const id = request.id
  try {
    const result = await answer(account, request, options)
    return { id, jsonrpc: '2.0', result }
  } catch (e) {
    return tonErrorResponse(id, e)
  }
}

async function answer(account: TonWcAccount | TonWcSigningAccount, request: WcSessionRequestLike, options: HandleTonRequestOptions): Promise<unknown> {
  const chainId = request.params?.chainId
  const method = request.params?.request?.method
  const network = tonNetworkOf(account.chain)
  if (!network) throw bad(`Not a TON account (chain ${account.chain}).`)
  if (typeof chainId !== 'string' || tonNetworkOf(chainId) === undefined) throw bad(`Unknown TON chain ${String(chainId)}.`)
  if (chainId !== account.chain) throw bad(`This wallet is on ${account.chain}; the request is for ${chainId}.`)
  if (method !== 'ton_sendMessage' && method !== 'ton_signData') throw new TonRequestError(TONCONNECT_ERRORS.methodNotSupported, `Method ${String(method)} is not supported.`)
  checkSession(options.session, account, chainId)
  const peerDomain = options.peerDomain ?? peerHost(options.session?.peer?.metadata?.url)
  const now = () => (options.now ? options.now() : Math.floor(Date.now() / 1000))
  const param = firstParam(request.params.request.params)
  const signWith = <T>(run: (a: TonWcSigningAccount) => Promise<T>): Promise<T> => {
    const guarded = (a: TonWcSigningAccount) => {
      if (!sameTonConnectAddress(a.address, account.address) || a.chain !== account.chain) throw bad('The signing account is not the account the session is for.')
      return run(a)
    }
    return options.withSigner ? options.withSigner(guarded) : guarded(requireSigning(account))
  }

  if (method === 'ton_signData') {
    const payload = parseSignData(param, { network, address: account.address })
    if (!peerDomain) throw bad("The dApp's domain is unknown, so the signature cannot be bound to it.")
    aborted(options.signal)
    if (!(await options.review({ method, chain: chainId, peerDomain, payload }))) throw new TonRequestError(TONCONNECT_ERRORS.userDeclined, 'The user rejected the request.')
    aborted(options.signal)
    const signed = await signWith((a) => a.signTonConnectData({ domain: peerDomain, timestamp: now(), payload }))
    // The TON Connect result (`address` raw), plus the `publicKey` the Reown TON reference lists.
    return { ...signed, publicKey: hex(account.publicKey) }
  }

  const maxMessages = Math.min(options.maxMessages ?? TONCONNECT_MAX_MESSAGES, TONCONNECT_MAX_MESSAGES)
  const parsed = parseSendTransaction(param, { network, address: account.address, maxMessages, now: now() })
  const transactions = tonConnectTransactions(parsed.messages)
  let description
  try { description = account.describe?.(transactions) } catch { description = undefined }
  const simulate = account.simulateTransaction ? () => account.simulateTransaction!(transactions) : undefined
  aborted(options.signal)
  const yes = await options.review({
    method, chain: chainId, request: parsed, transactions,
    ...(peerDomain !== undefined ? { peerDomain } : {}), ...(description !== undefined ? { description } : {}), ...(simulate ? { simulate } : {}),
  })
  if (!yes) throw new TonRequestError(TONCONNECT_ERRORS.userDeclined, 'The user rejected the request.')
  aborted(options.signal)
  // The review may have taken a while: the dApp's deadline still holds.
  if (parsed.validUntil !== undefined && parsed.validUntil < now()) throw bad('The request expired before it was signed.')
  const sent = await signWith((a) => a.sendTransaction(transactions))
  if (typeof sent.boc !== 'string' || !sent.boc) {
    throw new TonRequestError(TONCONNECT_ERRORS.unknown, `Sent (body hash ${sent.hash}), but the account returned no external message to answer with.`)
  }
  return sent.boc
}
