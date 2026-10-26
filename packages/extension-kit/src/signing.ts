/**
 * Signing requests from dApps (and from the wallet's own Send): classification,
 * transaction preparation, the review stop, the signature.
 *
 * Classification is Vaulty's `signingRequest` (mobile/lib/browser.ts): the
 * address a page names must be one the user connected; typed data bound to
 * another chain than the one the site is on is refused (4901); a transaction
 * must have a `to` (no deployments) and a `chainId`, when given, equal to the
 * site's chain; `eth_sign` never reaches here (the router refuses it).
 *
 * Preparation fills nonce, gas and fees from the wallet's own RPC (never the
 * page's): EIP-1559 cap = 2 × base fee + tip with the tip floored at 0.1 gwei
 * (Vaulty's `evmFees`), legacy `gasPrice` where a chain has no base fee, gas =
 * the page's limit or `eth_estimateGas` × 1.2.
 *
 * The nonce the sheet shows is a guess: the one signed is read AFTER the
 * approval, under a per-account lock that also covers the broadcast, and is
 * never below the wallet's own next nonce (a node may not see the previous
 * send yet). Two requests reviewed at once therefore get consecutive nonces.
 * The fee caps signed are the ones shown, unless the network outgrew them
 * while the sheet was open (EIP-1559: base fee + tip above the shown cap;
 * legacy: a higher gas price) — then the user is asked again with the new
 * numbers (`repriced: true`).
 *
 * The review payload ({@link SignApproval}) carries what the window shows: the
 * classified request, the prepared fields, the fee, and the preview the wallet
 * attached (tx-preview-evm: decode, simulation, balance changes, checks). Only
 * after the user approves does {@link SignDeps.signerFor} open the key; the
 * handle is disposed (zeroized) in `finally`, the raw transaction goes out via
 * `eth_sendRawTransaction` on the wallet's RPC.
 */
import { ApprovalQueue, type OriginVia } from './approvals.js'
import type { EvmNetwork } from './networks.js'
import { RELAY_ERRORS, type RelayError } from './relay.js'
import { RouterError, type RouterDeps } from './router.js'
import { describeSiwe, type SiweInfo } from './siwe.js'

/** The account nonce an RPC reported, refused when it is not a safe integer (a broken or hostile RPC). */
const safeNonce = (n: bigint): number => {
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`The RPC returned an impossible nonce (${n}).`)
  return Number(n.toString())
}

export type SignRequestInfo =
  | { kind: 'sign-message'; method: 'personal_sign'; account: string; /** Decoded text when printable, else the hex. */ text: string; /** What is actually signed (hex or utf-8 string). */ raw: string; /** Parsed Sign-In with Ethereum (EIP-4361) with the checks against the asking origin, when the text is one. */ siwe?: SiweInfo }
  | { kind: 'sign-typed-data'; method: string; account: string; /** Pretty-printed JSON. */ text: string; typedData: TypedData }
  | { kind: 'send-transaction'; method: 'eth_sendTransaction'; account: string; tx: { to: string; value: string; data: string | null; gas: string | null } }

export interface TypedData {
  domain: Record<string, unknown>
  types: Record<string, Array<{ name: string; type: string }>>
  message: Record<string, unknown>
  primaryType?: string
}

export interface PreparedTx {
  chainId: number
  nonce: number
  gasLimit: string
  /** EIP-1559 fields, or `gasPrice` on legacy-fee chains. All 0x hex. */
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  gasPrice?: string
  /** gasLimit × max fee, base units. */
  maxFee: string
}

/** The approval window's payload for the three signing kinds. */
export interface SignApproval {
  request: SignRequestInfo
  network: EvmNetwork
  prepared?: PreparedTx
  /** A second sheet for the same transaction: the network's fee outgrew the cap the first one showed. */
  repriced?: true
  /** What the wallet attached (tx-preview-evm `TxPreview`, typed-data description…). */
  preview: unknown
}

export interface EvmSigner {
  signMessage(message: string | Uint8Array): Promise<string>
  signTypedData(typed: TypedData): Promise<string>
  /** Fully specified tx (chainId, nonce, gas, fees) → signed raw transaction. */
  signTransaction(tx: { chainId: number; nonce: number; to: string; value: bigint; data: string; gasLimit: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint }): Promise<string>
}

export interface SignDeps {
  approvals: ApprovalQueue
  rpc(network: EvmNetwork, method: string, params: unknown[]): Promise<unknown>
  /** Opens the key for `address`; `dispose()` zeroizes it. */
  signerFor(address: string, network: EvmNetwork): Promise<{ signer: EvmSigner; dispose(): void }>
  /** Review data for the window (errors inside are the wallet's to swallow → `null`). */
  preview?(input: { network: EvmNetwork; request: SignRequestInfo; accounts: string[] }): Promise<unknown>
  /** Tip floor per chain id in wei (default 0.1 gwei everywhere). */
  tipFloor?: (chainId: number) => bigint
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX = /^0x([0-9a-fA-F]{2})*$/
const lc = (s: string) => s.toLowerCase()

/** Vaulty's `messageText`: hex that decodes to printable text is shown decoded; binary payloads stay hex. */
export function messageText(value: unknown): string {
  if (typeof value !== 'string') return ''
  if (!HEX.test(value)) return value
  try {
    const bytes = Uint8Array.from(value.slice(2).match(/../g) ?? [], (b) => Number.parseInt(b, 16))
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(s) ? s : value
  } catch {
    return value
  }
}

/**
 * The message as the signer will sign it: hex decoded when it is valid UTF-8, whatever
 * its printability (scan 2026-10-23 F7 — the SIWE checks must read the bytes that get
 * signed, not the hex fallback `messageText` shows for unprintable text).
 */
export function decodedMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!HEX.test(value)) return value
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value.slice(2).match(/../g) ?? [], (b) => Number.parseInt(b, 16)))
  } catch {
    return null
  }
}

/** Control characters other than tab / newline / carriage return — never part of an honest EIP-4361 message. */
const HIDDEN_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/

const err = (code: number, message: string): RelayError => ({ code, message })

/** Signing method + params → what the window reviews, or the error to answer with. */
export function classifySignRequest(input: { network: EvmNetwork; method: string; params: unknown[]; accounts: string[]; /** The asking page (browser-recorded) — needed for the SIWE domain check. */ origin?: string; /** Transport note for pseudo-origins (WalletConnect Verify), for the SIWE check. */ via?: OriginVia; now?: number }): SignRequestInfo | RelayError {
  const { method, params } = input
  const owned = new Set(input.accounts.map(lc))
  const ours = (a: unknown): a is string => typeof a === 'string' && ADDRESS.test(a) && owned.has(lc(a))
  const checksum = (a: string) => input.accounts.find((x) => lc(x) === lc(a)) ?? a

  if (method === 'personal_sign') {
    // [message, address] per spec; some dApps send [address, message].
    let [msg, addr] = params
    if (ours(msg) && !ours(addr)) [msg, addr] = [addr, msg]
    if (!ours(addr)) return err(RELAY_ERRORS.unauthorized, 'personal_sign for an address this wallet does not hold.')
    if (typeof msg !== 'string') return err(RELAY_ERRORS.invalidParams, 'personal_sign expects a message string.')
    const text = messageText(msg)
    const signed = decodedMessage(msg) ?? text
    const siwe = input.origin ? describeSiwe(signed, { origin: input.origin, account: checksum(addr), chainId: input.network.chainId, ...(input.via ? { via: input.via } : {}), ...(input.now !== undefined ? { now: input.now } : {}) }) : null
    // A sign-in message with hidden control characters would show as an opaque hex blob while
    // a lenient verifier still accepts it: refuse it outright.
    if (siwe && HIDDEN_CONTROL.test(signed)) return err(RELAY_ERRORS.invalidParams, 'This sign-in message contains hidden control characters — refused.')
    return { kind: 'sign-message', method, account: checksum(addr), text, raw: msg, ...(siwe ? { siwe } : {}) }
  }

  if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData_v3' || method === 'eth_signTypedData') {
    const [addr, data] = params
    if (!ours(addr)) return err(RELAY_ERRORS.unauthorized, 'signTypedData for an address this wallet does not hold.')
    let parsed: TypedData
    try {
      parsed = (typeof data === 'string' ? JSON.parse(data) : data) as TypedData
    } catch {
      return err(RELAY_ERRORS.invalidParams, 'Typed data is not valid JSON.')
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.domain !== 'object' || typeof parsed.types !== 'object' || typeof parsed.message !== 'object') {
      return err(RELAY_ERRORS.invalidParams, 'Typed data needs domain, types and message.')
    }
    const cid = parsed.domain.chainId
    if (cid !== undefined && cid !== null && Number(cid) !== input.network.chainId) {
      // A domain bound to another chain than the one the site is on is the classic cross-chain replay / phishing shape.
      return err(RELAY_ERRORS.chainDisconnected, `Typed data is for chain ${String(cid)}; this site is on ${input.network.name} (${input.network.chainId}).`)
    }
    return { kind: 'sign-typed-data', method, account: checksum(addr), text: JSON.stringify(parsed, bigintSafe, 2), typedData: parsed }
  }

  if (method === 'eth_sendTransaction') {
    const tx = (params[0] ?? {}) as { from?: unknown; to?: unknown; value?: unknown; data?: unknown; gas?: unknown; gasLimit?: unknown; chainId?: unknown; type?: unknown; authorizationList?: unknown }
    if (!ours(tx.from)) return err(RELAY_ERRORS.unauthorized, 'Transaction from an address this wallet does not hold.')
    // EIP-7702: a delegation hands the whole account to a contract; >80 % of early delegations went to sweepers. Sites never get one from this wallet.
    if ((Array.isArray(tx.authorizationList) && tx.authorizationList.length > 0) || tx.type === '0x4' || tx.type === 4) return err(RELAY_ERRORS.unsupportedMethod, 'EIP-7702 delegations (authorizationList / type 4) are never signed for a site by this wallet.')
    if (typeof tx.to !== 'string' || !ADDRESS.test(tx.to)) return err(RELAY_ERRORS.invalidParams, 'Contract deployment is not supported (a transaction needs a valid `to`).')
    if (tx.chainId !== undefined && tx.chainId !== null && Number(tx.chainId) !== input.network.chainId) return err(RELAY_ERRORS.chainDisconnected, 'Transaction chainId differs from the selected chain.')
    let value: string
    try {
      value = BigInt((tx.value as string | number | bigint | undefined) ?? 0).toString()
    } catch {
      return err(RELAY_ERRORS.invalidParams, 'Bad transaction value.')
    }
    const data = typeof tx.data === 'string' && tx.data !== '0x' ? tx.data : null
    if (data !== null && !HEX.test(data)) return err(RELAY_ERRORS.invalidParams, 'Transaction data is not hex.')
    const gasRaw = tx.gas ?? tx.gasLimit
    const gas = typeof gasRaw === 'string' && /^0x[0-9a-fA-F]+$/.test(gasRaw) ? gasRaw : null
    return { kind: 'send-transaction', method, account: checksum(tx.from), tx: { to: tx.to, value, data, gas } }
  }

  return err(RELAY_ERRORS.unsupportedMethod, `This wallet does not support ${method}.`)
}

const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)
const hex = (n: bigint) => `0x${n.toString(16)}`
const big = (v: unknown): bigint => BigInt(v as string)
const MIN_TIP_WEI = 100_000_000n // 0.1 gwei

type Fees = { base: bigint; tip: bigint } | { gasPrice: bigint }

/** The network's fee right now: base fee + floored tip, or the legacy gas price. */
async function readFees(deps: Pick<SignDeps, 'rpc' | 'tipFloor'>, network: EvmNetwork, block?: { baseFeePerGas?: string | null } | null): Promise<Fees> {
  const b = block === undefined ? ((await deps.rpc(network, 'eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas?: string | null } | null) : block
  const base = b?.baseFeePerGas != null ? big(b.baseFeePerGas) : null
  if (base === null) return { gasPrice: big(await deps.rpc(network, 'eth_gasPrice', [])) }
  const floor = deps.tipFloor?.(network.chainId) ?? MIN_TIP_WEI
  const nodeTip = await (deps.rpc(network, 'eth_maxPriorityFeePerGas', []) as Promise<string>).then(big).catch(() => 0n)
  return { base, tip: nodeTip > floor ? nodeTip : floor }
}

function withFees(chainId: number, nonce: number, gasLimit: bigint, fees: Fees): PreparedTx {
  if ('gasPrice' in fees) return { chainId, nonce, gasLimit: hex(gasLimit), gasPrice: hex(fees.gasPrice), maxFee: (gasLimit * fees.gasPrice).toString() }
  const maxFeePerGas = fees.base * 2n + fees.tip
  return { chainId, nonce, gasLimit: hex(gasLimit), maxFeePerGas: hex(maxFeePerGas), maxPriorityFeePerGas: hex(fees.tip), maxFee: (gasLimit * maxFeePerGas).toString() }
}

/** True when `shown` can no longer pay for inclusion at `now` (the user must see the new numbers). */
function outgrown(shown: PreparedTx, now: Fees): boolean {
  if ('gasPrice' in now) return shown.gasPrice === undefined || now.gasPrice > big(shown.gasPrice)
  return shown.maxFeePerGas === undefined || now.base + now.tip > big(shown.maxFeePerGas)
}

/** Nonce, gas, fees from the wallet's RPC. */
export async function prepareTransaction(deps: Pick<SignDeps, 'rpc' | 'tipFloor'>, network: EvmNetwork, from: string, tx: { to: string; value: string; data: string | null; gas: string | null }): Promise<PreparedTx> {
  const call = { from, to: tx.to, value: hex(BigInt(tx.value)), ...(tx.data ? { data: tx.data } : {}) }
  const [nonceHex, block, gasHex] = await Promise.all([
    deps.rpc(network, 'eth_getTransactionCount', [from, 'pending']),
    deps.rpc(network, 'eth_getBlockByNumber', ['latest', false]) as Promise<{ baseFeePerGas?: string | null } | null>,
    tx.gas ? Promise.resolve(tx.gas) : deps.rpc(network, 'eth_estimateGas', [call]),
  ])
  const estimated = big(gasHex)
  const gasLimit = tx.gas ? estimated : (estimated * 120n + 99n) / 100n
  return withFees(network.chainId, safeNonce(big(nonceHex)), gasLimit, await readFees(deps, network, block))
}

/** The router's `sign` hook: classify → prepare → review → sign (→ broadcast). */
export function createSignHandler(deps: SignDeps): NonNullable<RouterDeps['sign']> {
  // Per chain + account: the tail of the sign-and-broadcast queue and the next nonce this worker
  // handed out. Memory only — a restarted service worker starts again from the node's count.
  const tails = new Map<string, Promise<unknown>>()
  const nextNonce = new Map<string, number>()
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn)
    const tail = run.then(() => undefined, () => undefined)
    tails.set(key, tail)
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
    return run
  }

  return async ({ origin, network, method, params, accounts }) => {
    const via = deps.approvals.viaFor(origin)
    const info = classifySignRequest({ network, method, params, accounts, origin, ...(via ? { via } : {}) })
    if ('code' in info) throw RouterError.from(info)

    const prepared = info.kind === 'send-transaction' ? await prepareTransaction(deps, network, info.account, info.tx) : undefined
    const preview = deps.preview ? await deps.preview({ network, request: info, accounts }).catch(() => null) : null
    const payload: SignApproval = { request: info, network, ...(prepared ? { prepared } : {}), preview }
    await deps.approvals.request({ origin, chain: network.caip2, kind: info.kind, payload })

    if (info.kind === 'send-transaction') {
      const key = `${network.caip2}|${lc(info.account)}`
      return serial(key, async () => {
        let shown = prepared!
        for (;;) {
          const [nonceHex, fees] = await Promise.all([deps.rpc(network, 'eth_getTransactionCount', [info.account, 'pending']), readFees(deps, network)])
          const local = nextNonce.get(key) ?? 0
          const nodeNonce = safeNonce(big(nonceHex))
          const nonce = nodeNonce > local ? nodeNonce : local
          if (outgrown(shown, fees)) {
            shown = withFees(network.chainId, nonce, big(shown.gasLimit), fees)
            await deps.approvals.request({ origin, chain: network.caip2, kind: info.kind, payload: { ...payload, prepared: shown, repriced: true } })
            continue // the network may have moved again while the second sheet was open
          }
          const handle = await deps.signerFor(info.account, network)
          let raw: string
          try {
            raw = await handle.signer.signTransaction({
              chainId: shown.chainId, nonce, to: info.tx.to, value: BigInt(info.tx.value), data: info.tx.data ?? '0x', gasLimit: BigInt(shown.gasLimit),
              ...(shown.gasPrice !== undefined ? { gasPrice: BigInt(shown.gasPrice) } : { maxFeePerGas: BigInt(shown.maxFeePerGas!), maxPriorityFeePerGas: BigInt(shown.maxPriorityFeePerGas!) }),
            })
          } finally {
            handle.dispose()
          }
          const hash = await deps.rpc(network, 'eth_sendRawTransaction', [raw])
          nextNonce.set(key, nonce + 1)
          return hash
        }
      })
    }

    const handle = await deps.signerFor(info.account, network)
    try {
      switch (info.kind) {
        case 'sign-message':
          return await handle.signer.signMessage(HEX.test(info.raw) ? Uint8Array.from(info.raw.slice(2).match(/../g) ?? [], (b) => Number.parseInt(b, 16)) : info.raw)
        case 'sign-typed-data':
          return await handle.signer.signTypedData(info.typedData)
      }
    } finally {
      handle.dispose()
    }
  }
}
