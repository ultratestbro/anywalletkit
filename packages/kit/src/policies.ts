import { UserRejectedError, type IWalletAccount, type TransferOptions } from '@anywalletkit/core'
import { canonicalAddress, sendDestinations } from './destinations.js'

/**
 * Account methods the policies guard — everything that produces a signature
 * or a broadcast. The known surface is listed; on top of it any method whose
 * name starts with `sign`, `send`, `approve`, `revoke` or `transfer` (camelCase
 * boundary) is guarded too, so a chain package that adds a new signing method
 * cannot slip past the rules by not being named here. Opting a method out is
 * an explicit, reviewed entry in {@link UNGUARDED_WRITES}.
 */
export type KnownWriteMethod =
  | 'sendTransaction' | 'transfer' | 'signTransaction' | 'sign'
  | 'signTypedData' | 'signPermit' | 'approve'
  | 'signRaw' | 'signNep413' | 'signBuilt'
  | 'sendSerialized' | 'signCompiled' | 'signTransactionMessage'
  | 'revokeDelegation'
export type WriteMethod = KnownWriteMethod | (string & {})

export const GUARDED_WRITES: readonly KnownWriteMethod[] = [
  'sendTransaction', 'transfer', 'signTransaction', 'sign',
  'signTypedData', 'signPermit', 'approve',
  'signRaw', 'signNep413', 'signBuilt',
  'sendSerialized', 'signCompiled', 'signTransactionMessage',
  'revokeDelegation',
]
/** Name prefixes that mark a write even when the method is not listed above. */
export const GUARDED_PREFIXES: readonly string[] = ['sign', 'send', 'approve', 'revoke', 'transfer']
/** Explicit, reviewed opt-outs (none today). A name here is NOT guarded even if it matches a prefix. */
export const UNGUARDED_WRITES: readonly string[] = []

/** Is `name` a method the policies wrap? Reads (`get…`, `quote…`, `describe…`) never match. */
export function isGuardedWrite(name: string): boolean {
  if (UNGUARDED_WRITES.includes(name)) return false
  if ((GUARDED_WRITES as readonly string[]).includes(name)) return true
  return GUARDED_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length && /[A-Z0-9_]/.test(name[p.length]!))
}

/** Methods whose fee the account can quote up front (`maxFee` applies). */
const QUOTABLE: readonly string[] = ['sendTransaction', 'transfer', 'signTransaction']

/** Methods that sign an off-chain message: nothing moves, allow/block lists do not apply, only `confirm`. */
const MESSAGE_METHODS: readonly string[] = ['sign', 'signNep413']

/** Permit2 primary types (Uniswap Permit2): an allowance or a transfer authorisation for `spender`. */
const PERMIT2_TYPES = new Set(['PermitSingle', 'PermitBatch', 'PermitTransferFrom', 'PermitBatchTransferFrom', 'PermitWitnessTransferFrom', 'PermitBatchWitnessTransferFrom'])
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_UINT160 = (1n << 160n) - 1n

export type WriteKind =
  /** A transaction that moves value or calls a contract. */
  | 'send'
  /** An allowance for `to` (the spender) over `token`: `approve`, `signPermit`, EIP-2612 / Permit2 typed data. */
  | 'approval'
  /** Typed data that is not a known approval (an order, a vote…): `confirm` only, `to` = verifying contract. */
  | 'typedData'
  /** A plain message signature. */
  | 'message'
  /**
   * Takes rights away and moves nothing: `approve` / `signPermit` / EIP-2612 Permit of 0,
   * `approve(spender, 0)` / `approve(0x0, tokenId)` / `setApprovalForAll(operator, false)` /
   * Permit2 `lockdown` calldata (value 0), `revokeDelegation()`. The allowlist and the
   * spender's blocklist entry do not apply (revoking a drainer must stay possible); the
   * blocklist still applies to the contract the revoke calls; fee cap and `confirm` apply.
   */
  | 'revoke'

/** What a policy sees before a write goes out. Amounts in base units when known. */
export interface WriteIntent {
  chain: string
  /** Account address the write originates from. */
  from: string
  method: WriteMethod
  kind: WriteKind
  /** Destination when it can be read off the call: recipient, called contract, or the SPENDER of an approval. Read off `to` / `recipient` as given (apps match on it); the lists use {@link WriteIntent.destinations}. */
  to?: string
  /**
   * Every destination the write goes to, read per chain shape (scan F16/F17): each EVM call's `to`, the
   * NEAR `receiverId` (also of a base64 borsh transaction), Tron recipient / contract / resource receiver
   * decoded from `raw_data_hex` (never the optional JSON copy), every TON message, the recipients and
   * programs of decoded Solana instructions. Approvals: the spender; revokes: the contracts called;
   * message signatures: none. The allow/block lists check all of them.
   */
  destinations: string[]
  /**
   * Part of the write could not be read (an unknown shape, undecodable bytes, a lookup-table account):
   * `destinations` may be incomplete. With a blocklist for the chain and no `confirm` hook the write is
   * refused; with `confirm`, the hook sees this flag and decides; an allowlist refuses it.
   */
  destinationUnknown: boolean
  /** Token identifier for token transfers and approvals; undefined = native. */
  token?: string
  /** Amount when it can be read off the call (allowance for approvals). */
  amount?: bigint
  /** Approvals: the allowance is unbounded (uint256 / uint160 max, 2^255 and above, or a DAI-style `allowed`). */
  unlimited?: boolean
  /** Approvals / permits: expiry as given (unix seconds). */
  deadline?: bigint
  /** Revokes: what each one takes away (`spender` absent for a per-token NFT approval and an EIP-7702 delegation). */
  revokes?: Array<{ token: string; spender?: string }>
  /** The raw argument (first argument of the call), for policies that need more. */
  raw: unknown
  /** True for `kind` message / typedData: allow/block lists do not apply, only `confirm`. */
  message: boolean
}

export interface Policies {
  /** Per-chain fee cap in native base units; a quote above it throws before broadcast. */
  maxFee?: Record<string, bigint | number>
  /** Per-chain allowlist of destinations (case-insensitive) — recipients, called contracts and approval spenders. Writes to anything else throw. */
  allowlist?: Record<string, string[]>
  /** Per-chain blocklist of destinations — recipients, called contracts and approval spenders. */
  blocklist?: Record<string, string[]>
  /** Last word before broadcast: return false (or throw) to reject. Hook a confirmation UI here. */
  confirm?: (intent: WriteIntent) => boolean | Promise<boolean>
}

export class PolicyViolationError extends Error {
  readonly policy: 'maxFee' | 'allowlist' | 'blocklist' | 'chain'
  constructor(policy: 'maxFee' | 'allowlist' | 'blocklist' | 'chain', message: string) {
    super(message)
    this.name = 'PolicyViolationError'
    this.policy = policy
  }
}

const lower = (s: string | undefined) => s?.toLowerCase()
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const big = (v: unknown): bigint | undefined =>
  typeof v === 'bigint' ? v : typeof v === 'number' && Number.isFinite(v) ? BigInt(Math.trunc(v)) : typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v) ? BigInt(v) : undefined
const unboundedAllowance = (amount: bigint | undefined, max = MAX_UINT256): boolean => amount !== undefined && (amount >= 1n << 255n || amount === max)

/** An intent before {@link withDestinations}. */
type DraftIntent = Omit<WriteIntent, 'destinations' | 'destinationUnknown'>
type IntentBase = Omit<DraftIntent, 'kind' | 'message'>

function approvalIntent(base: IntentBase, spender: string | undefined, token: string | undefined, amount: bigint | undefined, deadline: bigint | undefined, unlimited: boolean): DraftIntent {
  return {
    ...base, kind: 'approval', message: false,
    ...(spender !== undefined ? { to: spender } : {}), ...(token !== undefined ? { token } : {}),
    ...(amount !== undefined ? { amount } : {}), ...(deadline !== undefined ? { deadline } : {}), unlimited,
  }
}

const SELECTOR_APPROVE = '0x095ea7b3' // approve(address,uint256) — ERC-20 allowance / ERC-721 per-token
const SELECTOR_SET_APPROVAL_FOR_ALL = '0xa22cb465' // setApprovalForAll(address,bool)
const SELECTOR_LOCKDOWN = '0xcc53287f' // Permit2 lockdown((address token, address spender)[])
const ZERO_WORD = '0'.repeat(64)
const wordAddress = (word: string) => `0x${word.slice(24)}`

/**
 * One EVM call → what it revokes, or null when it is anything else. Exact
 * shapes only: a known selector, the exact ABI length, no native value.
 */
function revokeCall(call: unknown): Array<{ token: string; spender?: string }> | null {
  const c = obj(call)
  const to = str(c.to)
  const data = str(c.data)?.toLowerCase()
  const value = big(c.value)
  if (to === undefined || data === undefined || (value !== undefined && value !== 0n) || (c.value !== undefined && value === undefined)) return null
  const words = data.slice(10)
  if (!/^[0-9a-f]*$/.test(words) || words.length % 64 !== 0) return null
  const word = (i: number) => words.slice(i * 64, i * 64 + 64)
  const selector = data.slice(0, 10)
  if (selector === SELECTOR_APPROVE && words.length === 128) {
    if (word(1) === ZERO_WORD) return [{ token: to, spender: wordAddress(word(0)) }] // ERC-20 allowance → 0
    if (word(0) === ZERO_WORD) return [{ token: to }] // ERC-721 approve(0x0, tokenId)
    return null
  }
  if (selector === SELECTOR_SET_APPROVAL_FOR_ALL && words.length === 128 && word(1) === ZERO_WORD) {
    return [{ token: to, spender: wordAddress(word(0)) }]
  }
  if (selector === SELECTOR_LOCKDOWN && words.length >= 128) {
    // offset (0x20), length n, then n × (token, spender)
    if (BigInt(`0x${word(0)}`) !== 32n) return null
    const n = Number(BigInt(`0x${word(1)}`))
    if (n < 1 || words.length !== (2 + 2 * n) * 64) return null
    const pairs: Array<{ token: string; spender?: string }> = []
    for (let i = 0; i < n; i++) pairs.push({ token: wordAddress(word(2 + 2 * i)), spender: wordAddress(word(3 + 2 * i)) })
    return pairs // the call itself goes to Permit2: revokeTargets() checks that contract
  }
  return null
}

/** Fields a non-EVM chain package signs instead of to/data/value — their presence rules out an EVM revoke. */
const FOREIGN_PAYLOAD_FIELDS = ['txID', 'raw_data', 'raw_data_hex', 'receiverId', 'receiver', 'actions', 'messageBytes', 'signatures', 'instructions', 'serialized', 'transaction', 'message'] as const

function carriesForeignPayload(call: unknown): boolean {
  if (typeof call !== 'object' || call === null) return true
  const c = call as Record<string, unknown>
  return FOREIGN_PAYLOAD_FIELDS.some((k) => c[k] !== undefined)
}

function revokeIntent(base: IntentBase, revokes: Array<{ token: string; spender?: string }>): DraftIntent {
  const first = revokes[0]
  return {
    ...base, kind: 'revoke', message: false, amount: 0n, unlimited: false,
    revokes: revokes.map(({ token, spender }) => (spender !== undefined ? { token, spender } : { token })),
    ...(revokes.length === 1 && first?.spender !== undefined ? { to: first.spender } : {}),
    ...(revokes.length === 1 && first !== undefined ? { token: first.token } : {}),
  }
}

/** The contracts a revoke intent calls: token / NFT contracts, Permit2 for a lockdown. */
function revokeTargets(intent: DraftIntent): string[] {
  const raw = intent.raw
  const calls = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  for (const c of calls) {
    const to = str(obj(c).to)
    if (to !== undefined) out.push(to)
  }
  if (out.length === 0) for (const r of intent.revokes ?? []) out.push(r.token)
  return out
}

/**
 * The EIP-712 primary type exactly as wallet-evm's signer picks it (scan F13):
 * the explicit `primaryType`, else the unique type no other type references
 * (`inferPrimaryType` in wallet-evm/read-only-account.ts). Ambiguous → throws,
 * as the signer does — the policy must never judge a different struct than the
 * one that gets signed.
 */
export function resolvePrimaryType(typed: unknown): string {
  const a = obj(typed)
  const explicit = str(a.primaryType)
  if (explicit !== undefined) return explicit
  const types = obj(a.types)
  const names = Object.keys(types).filter((t) => t !== 'EIP712Domain')
  const fieldsOf = (n: string) => (Array.isArray(types[n]) ? (types[n] as unknown[]) : [])
  // Linear, and identical to wallet-evm's inferPrimaryType: cut at the first '['. The old /\[.*\]$/
  // backtracked quadratically on a dApp's '[[[[…' type string and froze the wallet before any prompt (scan 2026-10-23 F10).
  const referenced = new Set(names.flatMap((n) => fieldsOf(n).map((f) => { const t = String(obj(f).type ?? ''); const i = t.indexOf('['); return i < 0 ? t : t.slice(0, i) })).filter((t) => names.includes(t)))
  const roots = names.filter((n) => !referenced.has(n))
  if (roots.length !== 1) throw new Error(`Ambiguous EIP-712 primary type: ${roots.join(', ') || 'none'}. Pass primaryType.`)
  return roots[0]!
}

/** EIP-712 input → approval intent for EIP-2612 `Permit` / Permit2, otherwise a confirm-only typed-data intent. */
function typedDataIntent(base: IntentBase, arg: unknown, primaryType: string): DraftIntent {
  const a = obj(arg)
  const domain = obj(a.domain)
  const message = obj(a.message)
  const types = obj(a.types)
  const verifying = str(domain.verifyingContract)
  // Only fields DECLARED in the primary struct are signed; an undeclared `allowed: false` is not part of the permit (scan F5).
  const declared = new Map((Array.isArray(types[primaryType]) ? (types[primaryType] as unknown[]) : []).map((f) => [str(obj(f).name) ?? '', str(obj(f).type) ?? ''] as const))
  const field = (name: string, type?: string): unknown => (declared.has(name) && (type === undefined || declared.get(name) === type) ? message[name] : undefined)
  const spender = str(field('spender', 'address'))
  if (primaryType === 'Permit' && spender !== undefined) {
    // EIP-2612 (`value`) or DAI-style (`allowed: true`, no value) permit on the verifying contract (the token).
    const amount = big(field('value', 'uint256'))
    const allowed = field('allowed', 'bool')
    if (verifying !== undefined && (amount === 0n || allowed === false)) return revokeIntent(base, [{ token: verifying, spender }])
    const unlimited = allowed === true || unboundedAllowance(amount)
    return approvalIntent(base, spender, verifying, amount, big(field('deadline') ?? field('expiry')), unlimited)
  }
  if (PERMIT2_TYPES.has(primaryType) && str(message.spender) !== undefined) {
    const details = Array.isArray(message.details) ? obj(message.details[0]) : obj(message.details ?? message.permitted)
    const amount = big(details.amount)
    return approvalIntent(base, str(message.spender), str(details.token), amount, big(message.sigDeadline ?? message.deadline ?? details.expiration), unboundedAllowance(amount, MAX_UINT160))
  }
  return { ...base, kind: 'typedData', message: true, ...(verifying !== undefined ? { to: verifying } : {}) }
}

/**
 * The destinations the lists check (scan F16/F17). `to` is left exactly as the call shape gave it — apps
 * match a reviewed write on it — and the lists read this instead.
 */
function withDestinations(intent: DraftIntent): WriteIntent {
  if (intent.message) return { ...intent, destinations: [], destinationUnknown: false }
  if (intent.kind === 'approval') return { ...intent, destinations: intent.to !== undefined ? [intent.to] : [], destinationUnknown: intent.to === undefined }
  if (intent.kind === 'revoke') return { ...intent, destinations: revokeTargets(intent), destinationUnknown: false }
  if (intent.method === 'transfer') {
    const r = str(obj(intent.raw).recipient) ?? str(obj(intent.raw).to)
    return { ...intent, destinations: r !== undefined ? [r] : [], destinationUnknown: r === undefined }
  }
  // signRaw is Tron's prebuilt-transaction signer and signBuilt NEAR's, whatever chain id the account reports.
  const chain = intent.method === 'signRaw' ? 'tron:' : intent.method === 'signBuilt' ? 'near:' : intent.chain
  const d = sendDestinations(chain, intent.raw)
  return { ...intent, destinations: d.list, destinationUnknown: d.unknown }
}

function intentOf(chain: string, from: string, method: WriteMethod, arg: unknown): WriteIntent {
  return withDestinations(draftIntentOf(chain, from, method, arg))
}

function draftIntentOf(chain: string, from: string, method: WriteMethod, arg: unknown): DraftIntent {
  const base = { chain, from, method, raw: arg }
  const a = obj(arg)
  switch (method) {
    case 'approve': {
      const amount = big(a.amount)
      if (amount === 0n && str(a.token) !== undefined) return revokeIntent(base, [{ token: str(a.token)!, ...(str(a.spender) !== undefined ? { spender: str(a.spender)! } : {}) }])
      return approvalIntent(base, str(a.spender), str(a.token), amount, undefined, unboundedAllowance(amount))
    }
    case 'signPermit': {
      const amount = big(a.value ?? a.amount)
      if (amount === 0n && str(a.token) !== undefined) return revokeIntent(base, [{ token: str(a.token)!, ...(str(a.spender) !== undefined ? { spender: str(a.spender)! } : {}) }])
      return approvalIntent(base, str(a.spender), str(a.token), amount, big(a.deadline), unboundedAllowance(amount))
    }
    case 'signTypedData':
      return typedDataIntent(base, arg, resolvePrimaryType(arg))
    case 'signBuilt': {
      // NEAR: a transaction built elsewhere, signed here — its receiver is the destination.
      const to = str(a.receiverId) ?? str(a.receiver)
      return { ...base, kind: 'send', message: false, ...(to !== undefined ? { to } : {}) }
    }
    case 'signRaw': {
      // Tron raw transaction: the first contract's `to_address` / `amount` when present (TransferContract / TRC-20 calls name the contract).
      const first = obj((obj(a.raw_data).contract as unknown[] | undefined)?.[0])
      const value = obj(obj(first.parameter).value)
      const to = str(value.to_address) ?? str(value.contract_address)
      const amount = big(value.amount)
      return { ...base, kind: 'send', message: false, ...(to !== undefined ? { to } : {}), ...(amount !== undefined ? { amount } : {}) }
    }
  }
  if (MESSAGE_METHODS.includes(method)) return { ...base, kind: 'message', message: true }
  if (method === 'revokeDelegation') return revokeIntent(base, [{ token: from }])
  if ((method === 'sendTransaction' || method === 'signTransaction') && chain.startsWith('eip155:')) {
    // A revoke sent as raw calldata (the approvals module's setApprovalForAll / lockdown / batch path).
    // EVM only, and only for plain EVM calls: Tron, NEAR and Solana sign other fields
    // (txID / raw_data_hex, receiverId / actions, messageBytes / instructions), so an EVM-looking
    // to/data riding along must never turn their write into a "revoke" that skips the lists (scan F1).
    const calls = Array.isArray(arg) ? arg : [arg]
    const found = calls.length > 0 && !calls.some(carriesForeignPayload) ? calls.map(revokeCall) : [null]
    if (found.every((r) => r !== null)) return revokeIntent(base, found.flat() as Array<{ token: string; spender?: string }>)
  }
  const to = str(a.to) ?? str(a.recipient)
  const amount = big(a.amount ?? a.value)
  return { ...base, kind: 'send', message: false, ...(to !== undefined ? { to } : {}), ...(typeof a.token === 'string' ? { token: a.token } : {}), ...(amount !== undefined ? { amount } : {}) }
}

/**
 * Wrap an account so every write passes the policies first. Reads are
 * untouched; every guarded method (see {@link isGuardedWrite}) that the
 * account has becomes: quote → fee cap (where the account can quote) →
 * allow/block lists (not for message signatures) → confirm → original call.
 * `signTransaction` is guarded like a send: a module that signs and
 * broadcasts on its own cannot skip the policies. Approvals (`approve`,
 * `signPermit`, EIP-2612 / Permit2 typed data) are checked against the
 * SPENDER: a blocklisted or non-allowlisted spender is refused, and `confirm`
 * sees `kind: 'approval'` with `unlimited`. A revoke (an approval of 0, the
 * revoke calldata the approvals module sends, `revokeDelegation`) is
 * `kind: 'revoke'`: it skips the allowlist and the spender's blocklist entry,
 * so a blocklisted drainer's allowance can always be taken back; the
 * blocklist still applies to the contract called, the fee cap and `confirm`
 * still apply.
 *
 * One check per user action: the original method runs on the unwrapped
 * account, so a write that an outer guarded method issues internally (the
 * `approve` reset that calls `sendTransaction`) is covered by the outer
 * check and is not confirmed a second time.
 *
 * `chain` is the CAIP-2 id the account was asked for (`Wallet.getAccount`
 * passes it). The rules of that id AND of `account.chain` both apply: an EVM
 * account built without `chainId` reports "eip155:unknown" until its first
 * RPC call, and a namespace registration can hand out an account whose RPC
 * is on another network than the one asked for — neither may let a write
 * slip past the rules written for the chain the app meant.
 */
export function applyPolicies<A extends IWalletAccount>(account: A, policies: Policies, chain?: string): A {
  const chainsOf = () => [...new Set([chain, account.chain].filter((c): c is string => c !== undefined && !c.endsWith(':unknown')))]
  const configured = [policies.maxFee, policies.allowlist, policies.blocklist].some((m) => m !== undefined && Object.keys(m).length > 0)
  const guard = async (method: WriteMethod, arg: unknown) => {
    let chains = chainsOf()
    // Called without `chain` on an EVM account that has not asked its RPC yet: learn the chain id now (audit F4).
    // If it stays unknown, per-chain rules cannot be picked — refuse instead of letting the write through unchecked.
    if (chains.length === 0 && configured) {
      const getChainId = (account as { getChainId?: () => Promise<number | bigint> }).getChainId
      const ns = account.chain.split(':')[0]
      if (account.chain.endsWith(':unknown') && typeof getChainId === 'function') chains = [`${ns}:${await getChainId.call(account)}`]
      if (chains.length === 0) throw new PolicyViolationError('chain', `The account's chain is unknown (${account.chain}), so its policies cannot be applied.`)
    }
    const intent = intentOf(chains[0] ?? account.chain, await account.getAddress(), method, arg)
    const caps = chains.flatMap((c) => { const cap = policies.maxFee?.[c]; return cap === undefined ? [] : [{ c, cap: BigInt(cap) }] })
    if (caps.length > 0 && QUOTABLE.includes(method)) {
      const { fee } = method === 'transfer' ? await account.quoteTransfer(arg as TransferOptions) : await account.quoteSendTransaction(arg)
      for (const { c, cap } of caps) if (fee > cap) throw new PolicyViolationError('maxFee', `Fee ${fee} exceeds the ${c} cap of ${cap}.`)
    }
    // Addresses are compared in one canonical form per chain (EVM lowercase, Tron 41-hex, TON raw), both sides (scan F17).
    const listed = (c: string, list: string[] | undefined) => (list ? new Set(list.map((a) => canonicalAddress(c, a))) : undefined)
    if (intent.kind === 'revoke') {
      // Revoking takes rights away: the allowlist and the spender's listing do not apply.
      // The contract it calls must still not be blocklisted.
      for (const c of chains) {
        const block = listed(c, policies.blocklist?.[c])
        const hit = block && revokeTargets(intent).find((t) => block.has(canonicalAddress(c, t)))
        if (hit) throw new PolicyViolationError('blocklist', `Contract ${hit} is on the ${c} blocklist.`)
      }
    } else if (!intent.message) {
      const what = intent.kind === 'approval' ? 'Spender' : 'Destination'
      for (const c of chains) {
        const allow = listed(c, policies.allowlist?.[c])
        if (allow) {
          const outside = intent.destinations.find((d) => !allow.has(canonicalAddress(c, d)))
          if (outside !== undefined || intent.destinations.length === 0 || intent.destinationUnknown) {
            throw new PolicyViolationError('allowlist', `${what} ${outside ?? '(unknown)'} is not on the ${c} allowlist.`)
          }
        }
        const block = listed(c, policies.blocklist?.[c])
        if (block) {
          const hit = intent.destinations.find((d) => block.has(canonicalAddress(c, d)))
          if (hit !== undefined) throw new PolicyViolationError('blocklist', `${what} ${hit} is on the ${c} blocklist.`)
          // Fail closed only when nobody else can look (scan F16); with a confirm hook it sees destinationUnknown.
          if (intent.destinationUnknown && !policies.confirm) throw new PolicyViolationError('blocklist', `Cannot tell every destination of this ${intent.method} on ${c}, and the ${c} blocklist is on with no confirm hook to ask.`)
        }
      }
    }
    if (policies.confirm && !(await policies.confirm(intent))) throw new UserRejectedError('The write was not confirmed.')
  }
  const wrapped = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  return new Proxy(account, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (typeof v !== 'function') return v
      if (typeof prop === 'string' && isGuardedWrite(prop)) {
        let fn = wrapped.get(prop)
        if (!fn) {
          const original = v as (...args: unknown[]) => Promise<unknown>
          fn = async (...args: unknown[]) => {
            await guard(prop, args[0])
            // EIP-712 without primaryType: hand the signer the type the policy judged, so the two cannot diverge (scan F13).
            // Same struct, same hash — only the inference is made explicit.
            if (prop === 'signTypedData' && typeof args[0] === 'object' && args[0] !== null && str(obj(args[0]).primaryType) === undefined) {
              return original.apply(target, [{ ...(args[0] as Record<string, unknown>), primaryType: resolvePrimaryType(args[0]) }, ...args.slice(1)])
            }
            return original.apply(target, args)
          }
          wrapped.set(prop, fn)
        }
        return fn
      }
      return v.bind(target)
    },
  })
}
