import { UserRejectedError, isUnlimitedAllowance, type IWalletAccount, type TransferOptions, type WriteOptions } from '@anywalletkit/core'
import { canonicalNamespace, isConcreteChain, ruleCovers, sameChain } from './chain-id.js'
import { canonicalAddress, erc20Transfer, hexData, sendDestinations, tonRawAddress, tronCallData, tronRawIntent } from './destinations.js'
import { snapshot } from './snapshot.js'
import { ccAssetByToken } from '@anywalletkit/swap2-assets'
import { catalogChain } from './activity/generic.js'

/**
 * Account methods the policies guard — everything that produces a signature
 * or a broadcast. The known surface is listed; any other method whose name
 * starts with `sign`, `send`, `approve`, `revoke` or `transfer` (camelCase
 * boundary) is refused outright behind the wrapper: the policies cannot read
 * what an unlisted method signs (a chain package's internal helper takes its
 * recipient somewhere the rules never look — scan 2026-10-27 F1), so a new
 * signing method must be listed here, with its intent, before it is reachable.
 * Opting a method out is an explicit, reviewed entry in {@link UNGUARDED_WRITES}.
 */
export type KnownWriteMethod =
  | 'sendTransaction' | 'transfer' | 'signTransaction' | 'sign'
  | 'signTypedData' | 'signPermit' | 'approve'
  | 'signRaw' | 'signNep413' | 'signBuilt' | 'signTonProof' | 'signTonConnectData'
  | 'sendSerialized' | 'signCompiled' | 'signTransactionMessage'
  | 'revokeDelegation' | 'sendSerializedTransaction'
/**
 * A method name the policies may see: one of {@link KnownWriteMethod}, or any other name a chain
 * package adds.
 */
export type WriteMethod = KnownWriteMethod | (string & {})

/**
 * The known write methods, wrapped on every account the kit hands out. Names outside this list are
 * still guarded when they start with one of {@link GUARDED_PREFIXES}.
 */
export const GUARDED_WRITES: readonly KnownWriteMethod[] = [
  'sendTransaction', 'transfer', 'signTransaction', 'sign',
  'signTypedData', 'signPermit', 'approve',
  'signRaw', 'signNep413', 'signBuilt', 'signTonProof', 'signTonConnectData',
  'sendSerialized', 'signCompiled', 'signTransactionMessage',
  'revokeDelegation', 'sendSerializedTransaction',
]
/** Name prefixes that mark a write even when the method is not listed above (such a method is refused). */
export const GUARDED_PREFIXES: readonly string[] = ['sign', 'send', 'approve', 'revoke', 'transfer']
/**
 * Explicit, reviewed opt-outs. A name here is NOT guarded even if it matches a prefix.
 * `transferActions` (NEAR) builds the actions of a transfer and signs nothing.
 */
export const UNGUARDED_WRITES: readonly string[] = ['transferActions']

/** Is `name` a method the policies wrap (or, outside {@link GUARDED_WRITES}, refuse)? Reads (`get…`, `quote…`, `describe…`) never match. */
export function isGuardedWrite(name: string): boolean {
  if (UNGUARDED_WRITES.includes(name)) return false
  if ((GUARDED_WRITES as readonly string[]).includes(name)) return true
  return GUARDED_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length && /[A-Z0-9_]/.test(name[p.length]!))
}

/** A write by its name only: not in {@link GUARDED_WRITES}, so nothing reads what it signs. */
function isUnlistedWrite(name: string): boolean {
  return isGuardedWrite(name) && !(GUARDED_WRITES as readonly string[]).includes(name)
}

/** Methods whose fee the account can quote up front (`maxFee` is checked on the quote, then passed on). */
const QUOTABLE: readonly string[] = ['sendTransaction', 'transfer', 'signTransaction']
/**
 * Every method that pays a fee and takes `WriteOptions`, with the argument it takes them at: the
 * account holds `maxFee` on what it signs. `approve` (EVM), `sendSerialized` (Solana), `signRaw`
 * (Tron), `revokeDelegation` (EIP-7702) and swap2's `sendSerializedTransaction` hook have no
 * generic quote, so for them this is the only check (round 3, M8).
 */
const CAPPED: Readonly<Record<string, number>> = Object.freeze({
  sendTransaction: 1, transfer: 1, signTransaction: 1, approve: 1, sendSerialized: 2,
  signRaw: 1, revokeDelegation: 0, sendSerializedTransaction: 2,
})

/** Methods that sign an off-chain message: nothing moves, allow/block lists do not apply, only `confirm`. */
const MESSAGE_METHODS: readonly string[] = ['sign', 'signNep413', 'signTonProof', 'signTonConnectData']
/** Off-chain signatures pay no fee: a fee cap does not apply to them. */
const FEE_FREE: readonly string[] = [...MESSAGE_METHODS, 'signTypedData', 'signPermit']

/** A chain id as callers and dApps write it (number, bigint, decimal or 0x string) → decimal, or undefined. */
function chainIdRef(v: unknown): string | undefined {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : undefined
  if (typeof v === 'bigint') return v >= 0n ? v.toString() : undefined
  // The grammar wallet-evm's chainIdNumber accepts (decimal or 0x-hex, within 2^53).
  if (typeof v === 'string' && /^(\d{1,16}|0x[0-9a-fA-F]{1,14})$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER)) return BigInt(v).toString()
  return undefined
}

/**
 * The EVM network a transaction signs for, read off it (its `chainId`), when it carries one. A chainId
 * that is there but not a chain id these rules read ('0b10001001', ' 137') is refused: wallet-evm
 * refuses it too, and treating it as absent let an offline account sign for another chain under
 * the rules of the one asked for (scan 2026-10-27 F30).
 */
function signedChain(ns: string, method: string, arg: unknown): string | undefined {
  if (ns !== 'eip155' || (method !== 'sendTransaction' && method !== 'signTransaction') || Array.isArray(arg)) return undefined
  const raw = obj(arg).chainId
  const ref = chainIdRef(raw)
  if (raw !== undefined && ref === undefined) throw new PolicyViolationError('chain', `chainId ${JSON.stringify(String(raw)).slice(0, 40)} is not a chain id; nothing was signed.`)
  return ref === undefined ? undefined : `eip155:${ref}`
}

/**
 * An off-chain signature: a message valid on every network, or typed data, whose domain chainId
 * the chain package judges (wallet-evm refuses a foreign one unless `allowCrossChainTypedData`).
 */
function chainFree(method: string): boolean {
  return MESSAGE_METHODS.includes(method) || method === 'signTypedData'
}

/** An account built without any provider (wallet-evm keeps it in `_config`): it signs offline and cannot learn its chain. */
function isOffline(account: unknown): boolean {
  const config = (account as { _config?: { provider?: unknown } })._config
  return config !== undefined && (config.provider === undefined || (Array.isArray(config.provider) && config.provider.length === 0))
}

/** Permit2 primary types (Uniswap Permit2): an allowance or a transfer authorisation for `spender`. */
const PERMIT2_TYPES = new Set(['PermitSingle', 'PermitBatch', 'PermitTransferFrom', 'PermitBatchTransferFrom', 'PermitWitnessTransferFrom', 'PermitBatchWitnessTransferFrom'])
const MAX_UINT256 = (1n << 256n) - 1n

/**
 * What a write does, as the policies classify it. The kind decides which rules apply: lists and fee
 * cap for `send`, a spender check for `approval`, `confirm` only for messages.
 */
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
   * `approve(0x0, tokenId)` / `setApprovalForAll(operator, false)` / Permit2 `lockdown`
   * calldata (value 0), `revokeDelegation()`. Raw `approve(spender, 0)` calldata is an
   * `approval` instead: on an ERC-721 it grants token #0. The allowlist and the
   * spender's blocklist entry do not apply (revoking a drainer must stay possible); the
   * blocklist still applies to the contract the revoke calls; fee cap and `confirm` apply.
   */
  | 'revoke'

/** What a policy sees before a write goes out. Amounts in base units when known. */
export interface WriteIntent {
  /** CAIP-2 chain id of the account that writes. */
  chain: string
  /** Account address the write originates from. */
  from: string
  /** The account method that was called. */
  method: WriteMethod
  /** What the write does; see {@link WriteKind}. */
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
  /**
   * Approvals: the allowance is unbounded — type(uint128).max or above (`isUnlimitedAllowance` in
   * core), a DAI-style `allowed`, or an amount the policies cannot read (the worst case is shown).
   * For a Permit2 batch: any of its entries.
   */
  unlimited?: boolean
  /**
   * Approvals: every token the write grants, one entry each (a Permit2 batch carries several).
   * `token` / `amount` above are set only when there is exactly one.
   */
  approvals?: Array<{ token?: string; amount?: bigint; unlimited: boolean }>
  /** Approvals / permits: expiry as given (unix seconds). */
  deadline?: bigint
  /**
   * TON jetton `transfer()`: nanotons attached to the jetton-wallet call. The jetton wallet keeps
   * the gas, forwards `forwardTonAmount` to the recipient and returns the rest to the response
   * destination. Undefined when the caller did not set it (the wallet's default applies).
   */
  attachedValue?: bigint
  /** TON jetton `transfer()`: nanotons forwarded to the recipient with the transfer notification, when set. */
  forwardTonAmount?: bigint
  /** Revokes: what each one takes away (`spender` absent for a per-token NFT approval and an EIP-7702 delegation). */
  revokes?: Array<{ token: string; spender?: string }>
  /** The raw argument (first argument of the call), for policies that need more. */
  raw: unknown
  /** True for `kind` message / typedData: allow/block lists do not apply, only `confirm`. */
  message: boolean
}

/**
 * Rules the kit checks before every signature and broadcast of an account it hands out. Keys of the
 * per-chain records are CAIP-2 ids or namespace prefixes (`eip155`). A namespace key covers every
 * chain of the family, and an exact id's rules apply on top of it: every matching fee cap is
 * checked, a destination must be on every matching allowlist, and any matching blocklist refuses.
 * An id matches its network in any spelling: `solana:mainnet` = `solana:5eykt…`,
 * `tron:728126428` = `tron:mainnet` = `tron:0x2b6653dc`, `bitcoin:mainnet` = `bip122:0000…`,
 * `eip155:0x1` = `eip155:1`; the `bitcoin` namespace is `bip122`.
 */
export interface Policies {
  /**
   * Per-chain fee cap in native base units. A quote above it throws before `confirm`; the cap is
   * then handed to the account as `WriteOptions.maxFee`, so chain packages check it again on the
   * transaction they sign (EVM: gas limit with headroom × the signed gas price).
   */
  maxFee?: Record<string, bigint | number>
  /** Per-chain allowlist of destinations (case-insensitive) — recipients, called contracts and approval spenders. Writes to anything else throw. */
  allowlist?: Record<string, string[]>
  /** Per-chain blocklist of destinations — recipients, called contracts and approval spenders. */
  blocklist?: Record<string, string[]>
  /** Last word before broadcast: return false (or throw) to reject. Hook a confirmation UI here. */
  confirm?: (intent: WriteIntent) => boolean | Promise<boolean>
}

/**
 * Thrown before anything is signed when a write breaks a rule in {@link Policies}. A rejected
 * `confirm` throws `UserRejectedError` from core instead.
 */
export class PolicyViolationError extends Error {
  /**
   * The rule that refused the write. `chain` means the account's chain id is unknown, so no rule
   * could be matched. `method` means the method is not part of the write surface the policies
   * can read (see {@link GUARDED_WRITES}).
   */
  readonly policy: 'maxFee' | 'allowlist' | 'blocklist' | 'chain' | 'method'
  constructor(policy: 'maxFee' | 'allowlist' | 'blocklist' | 'chain' | 'method', message: string) {
    super(message)
    this.name = 'PolicyViolationError'
    this.policy = policy
  }
}

const lower = (s: string | undefined) => s?.toLowerCase()
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
/**
 * A uint as the signer reads it. wallet-evm and viem pass strings and numbers through BigInt(), so
 * ' 0x…', '0X…', '0b…', '0o…' and surrounding whitespace are numbers there and must be here too
 * (round 3, M3). A non-integer number or anything else is unreadable (undefined).
 */
const big = (v: unknown): bigint | undefined => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : undefined
  if (typeof v === 'string' && v.length <= 300) { try { return BigInt(v) } catch { return undefined } }
  return undefined
}
/** An allowance given as `raw`: unlimited at or above type(uint128).max, or when it is present but unreadable (the worst case is what `confirm` must see). */
const allowanceUnlimited = (raw: unknown, amount: bigint | undefined): boolean => (amount === undefined ? raw !== undefined : isUnlimitedAllowance(amount))

/** Solana token accounts an intent pays into, whose owners {@link applyPolicies} still has to read (round 3, M1). */
const PENDING_TOKEN_ACCOUNTS = new WeakMap<WriteIntent, string[]>()

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
    // ERC-721 approve(0x0, tokenId) clears the token's approval (an ERC-20 approve to 0x0 reverts).
    // approve(spender, 0) is NOT read as a revoke: on an ERC-20 it zeroes the allowance, on an
    // ERC-721 it approves `spender` for token #0, and the calldata cannot tell which (audit #5).
    // An ERC-20 revoke that must skip the lists goes through the account's `approve({amount: 0})`.
    if (word(0) === ZERO_WORD) return [{ token: to }]
    return null
  }
  if (selector === SELECTOR_SET_APPROVAL_FOR_ALL && words.length === 128 && word(1) === ZERO_WORD) {
    return [{ token: to, spender: wordAddress(word(0)) }]
  }
  if (selector === SELECTOR_LOCKDOWN && words.length >= 128) {
    // offset (0x20), length n, then n × (token, spender)
    if (BigInt(`0x${word(0)}`) !== 32n) return null
    const count = BigInt(`0x${word(1)}`)
    if (count < 1n || count > BigInt(words.length)) return null // bounded before it becomes a number
    const n = Number(count.toString())
    if (words.length !== (2 + 2 * n) * 64) return null
    const pairs: Array<{ token: string; spender?: string }> = []
    for (let i = 0; i < n; i++) pairs.push({ token: wordAddress(word(2 + 2 * i)), spender: wordAddress(word(3 + 2 * i)) })
    return pairs // the call itself goes to Permit2: revokeTargets() checks that contract
  }
  return null
}

/**
 * Rights a raw EVM call grants, read off exact calldata shapes: `approve(spender, x)` with a
 * non-zero spender (ERC-20 allowance or ERC-721 per-token approval) and
 * `setApprovalForAll(operator, true)`. The lists check these spenders like any destination.
 */
function grantCall(call: unknown): { token: string; spender: string; amount: bigint } | null {
  const c = obj(call)
  const to = str(c.to)
  const data = str(c.data)?.toLowerCase()
  const value = big(c.value)
  if (to === undefined || data === undefined || (value !== undefined && value !== 0n) || (c.value !== undefined && value === undefined)) return null
  if (data.length !== 10 + 128 || !/^0x[0-9a-f]*$/.test(data)) return null
  const [w0, w1] = [data.slice(10, 74), data.slice(74)]
  if (w0 === ZERO_WORD) return null
  if (data.startsWith(SELECTOR_APPROVE)) return { token: to, spender: wordAddress(w0), amount: BigInt(`0x${w1}`) }
  if (data.startsWith(SELECTOR_SET_APPROVAL_FOR_ALL) && w1 !== ZERO_WORD) return { token: to, spender: wordAddress(w0), amount: MAX_UINT256 }
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
    // No uint256 `value` the policies can read and no DAI `allowed: true`: the grant is unknown, so the worst case (round 3, M3).
    const unlimited = allowed === true || amount === undefined || isUnlimitedAllowance(amount)
    return approvalIntent(base, spender, verifying, amount, big(field('deadline') ?? field('expiry')), unlimited)
  }
  if (PERMIT2_TYPES.has(primaryType) && str(message.spender) !== undefined) {
    // Every entry: `details` (allowance permits) or `permitted` (transfer permits), one or a batch (round 3, M3).
    const field = message.details !== undefined ? message.details : message.permitted
    const entries = (Array.isArray(field) ? field : field !== undefined ? [field] : []).map(obj)
    const approvals = entries.map((d) => {
      const amount = big(d.amount)
      return { ...(str(d.token) !== undefined ? { token: str(d.token)! } : {}), ...(amount !== undefined ? { amount } : {}), unlimited: allowanceUnlimited(d.amount, amount) }
    })
    const one = approvals.length === 1 ? approvals[0] : undefined
    const expiry = big(message.sigDeadline ?? message.deadline ?? (one ? entries[0]!.expiration : undefined))
    // No entry at all: nothing tells what is granted, so the worst case.
    const unlimited = approvals.length === 0 || approvals.some((a) => a.unlimited)
    return { ...approvalIntent(base, str(message.spender), one?.token, one?.amount, expiry, unlimited), approvals }
  }
  return { ...base, kind: 'typedData', message: true, ...(verifying !== undefined ? { to: verifying } : {}) }
}

/**
 * The destinations the lists check (scan F16/F17). `to` is left exactly as the call shape gave it — apps
 * match a reviewed write on it — and the lists read this instead.
 */
function withDestinations(intent: DraftIntent): WriteIntent {
  if (intent.message) return { ...intent, destinations: [], destinationUnknown: false }
  if (intent.kind === 'approval') {
    // Raw approval calldata (sendTransaction / signTransaction, one call or a one-call batch):
    // the contract called is checked as well as the spender.
    const raw = intent.method === 'sendTransaction' || intent.method === 'signTransaction' ? (Array.isArray(intent.raw) ? intent.raw : [intent.raw]) : []
    const called = raw.flatMap((c) => { const to = str(obj(c).to); return to !== undefined ? [to] : [] })
    return { ...intent, destinations: [...called, ...(intent.to !== undefined ? [intent.to] : [])], destinationUnknown: intent.to === undefined }
  }
  if (intent.kind === 'revoke') return { ...intent, destinations: revokeTargets(intent), destinationUnknown: false }
  if (intent.method === 'transfer') {
    // Every chain package pays `recipient` and reads nothing else; a `to` that names another
    // address makes the call ambiguous (round 3, M4).
    const a = obj(intent.raw)
    const r = str(a.recipient)
    const to = str(a.to)
    const conflicting = r !== undefined && to !== undefined && canonicalAddress(intent.chain, to) !== canonicalAddress(intent.chain, r)
    const jetton = intent.chain.startsWith('ton:') && a.token !== undefined ? tonJettonTransfer(intent.chain, intent.from, a) : { list: [], unknown: false }
    return { ...intent, destinations: [...(r !== undefined ? [r] : []), ...jetton.list], destinationUnknown: r === undefined || conflicting || jetton.unknown }
  }
  // signRaw is Tron's prebuilt-transaction signer and signBuilt NEAR's, whatever chain id the account reports.
  const chain = intent.method === 'signRaw' ? 'tron:' : intent.method === 'signBuilt' ? 'near:' : intent.chain
  const d = sendDestinations(chain, intent.raw)
  // A batch may carry approvals among its calls: their spenders are destinations too.
  const granted = chain.startsWith('eip155:') && Array.isArray(intent.raw) ? intent.raw.flatMap((c) => { const g = grantCall(c); return g ? [g.spender] : [] }) : []
  const out: WriteIntent = { ...intent, destinations: [...new Set([...d.list, ...granted])], destinationUnknown: d.unknown }
  if (d.tokenAccounts) PENDING_TOKEN_ACCOUNTS.set(out, d.tokenAccounts)
  return out
}

/**
 * What else a TON jetton `transfer()` pays besides its recipient (scan 2026-10-27 F3, F5, F9). The
 * master the caller names decides which contract receives `attachedValue` (a fake master returns an
 * attacker's contract as "the jetton wallet"), and the response destination receives the excess,
 * unless it is the wallet itself. A forward or custom payload cell is acted on by the recipient (a
 * DEX swaps and pays whoever it names) and is not read here; a text forward payload is a comment.
 */
function tonJettonTransfer(chain: string, from: string, a: Record<string, unknown>): { list: string[]; unknown: boolean } {
  const list: string[] = []
  let unknown = false
  const token = str(a.token)
  if (token === undefined) unknown = true
  else list.push(token)
  if (a.responseDestination !== undefined) {
    const response = str(a.responseDestination)
    if (response === undefined) unknown = true
    else if (canonicalAddress(chain, response) !== canonicalAddress(chain, from)) list.push(response)
  }
  if (a.customPayload !== undefined || (a.forwardPayload !== undefined && typeof a.forwardPayload !== 'string')) unknown = true
  return { list, unknown }
}

/** What {@link intentOf} needs to know beyond the arguments: whether an `approve` of 0 is on a known ERC-20. */
interface IntentContext { erc20?: boolean }

/**
 * Is `approve({ token, amount: 0 })` on an ERC-20? On an ERC-721, approve(spender, 0) APPROVES token
 * #0, so it is a revoke only on a token the swap2-assets catalog lists or the account reads as an
 * ERC-20 (`getTokenInfo`); anything else is an approval of the spender (scan 2026-10-27 F20, the
 * raw-calldata rule of audit #5).
 */
async function approveRevokesErc20(chain: string, method: WriteMethod, arg: unknown, account: unknown): Promise<boolean> {
  const a = obj(arg)
  const token = str(a.token)
  if (method !== 'approve' || !chain.startsWith('eip155:') || token === undefined || big(a.amount) !== 0n) return false
  if (ccAssetByToken(catalogChain(chain), token) !== undefined) return true
  const read = (account as { getTokenInfo?: (t: string) => Promise<{ standard?: unknown }> }).getTokenInfo
  if (typeof read !== 'function') return false
  try { return (await read.call(account, token)).standard === 'erc20' } catch { return false }
}

function intentOf(chain: string, from: string, method: WriteMethod, arg: unknown, ctx: IntentContext = {}): WriteIntent {
  const intent = withDestinations(draftIntentOf(chain, from, method, arg, ctx))
  // TON: a destination in a spelling the lists cannot compare ('+0:…', ' 0:…', '0.0:…') is not a
  // known one, whatever the chain package makes of it (scan 2026-10-27 F18).
  if (canonicalNamespace(chain.split(':')[0]!) === 'ton' && intent.destinations.some((d) => tonRawAddress(d) === null)) intent.destinationUnknown = true
  return intent
}

function draftIntentOf(chain: string, from: string, method: WriteMethod, arg: unknown, ctx: IntentContext = {}): DraftIntent {
  const base = { chain, from, method, raw: arg }
  const a = obj(arg)
  switch (method) {
    case 'approve': {
      const amount = big(a.amount)
      // A revoke only on a known ERC-20; on anything else approve(spender, 0) may grant NFT #0 (scan 2026-10-27 F20).
      if (amount === 0n && str(a.token) !== undefined && ctx.erc20 === true) return revokeIntent(base, [{ token: str(a.token)!, ...(str(a.spender) !== undefined ? { spender: str(a.spender)! } : {}) }])
      return approvalIntent(base, str(a.spender), str(a.token), amount, undefined, allowanceUnlimited(a.amount, amount))
    }
    case 'signPermit': {
      const amount = big(a.value ?? a.amount)
      if (amount === 0n && str(a.token) !== undefined) return revokeIntent(base, [{ token: str(a.token)!, ...(str(a.spender) !== undefined ? { spender: str(a.spender)! } : {}) }])
      return approvalIntent(base, str(a.spender), str(a.token), amount, big(a.deadline), allowanceUnlimited(a.value ?? a.amount, amount))
    }
    case 'signTypedData':
      return typedDataIntent(base, arg, resolvePrimaryType(arg))
    case 'signBuilt': {
      // NEAR: a transaction built elsewhere, signed here — its receiver is the destination.
      const to = str(a.receiverId)
      return { ...base, kind: 'send', message: false, ...(to !== undefined ? { to } : {}) }
    }
    case 'transfer': {
      // The recipient the chain package pays, never `to` (round 3, M4).
      const to = str(a.recipient)
      const amount = big(a.amount)
      // A TON jetton transfer also spends TON: what confirm must show next to the jetton amount (scan 2026-10-27 F3).
      const ton = chain.startsWith('ton:') && a.token !== undefined
      const attachedValue = ton ? big(a.attachedValue) : undefined
      const forwardTonAmount = ton ? big(a.forwardTonAmount) : undefined
      return {
        ...base, kind: 'send', message: false, ...(to !== undefined ? { to } : {}), ...(typeof a.token === 'string' ? { token: a.token } : {}), ...(amount !== undefined ? { amount } : {}),
        ...(attachedValue !== undefined ? { attachedValue } : {}), ...(forwardTonAmount !== undefined ? { forwardTonAmount } : {}),
      }
    }
    case 'signRaw': {
      // Tron raw transaction: what the signed bytes (raw_data_hex) pay, never the JSON copy — a vote's JSON
      // could say "1 TRX to the merchant" (scan 2026-10-27 F26). TRC-20 calls name the contract, with the token amount.
      const r = tronRawIntent(a.raw_data_hex)
      return { ...base, kind: 'send', message: false, ...(r.to !== undefined ? { to: r.to } : {}), ...(r.token !== undefined ? { token: r.token } : {}), ...(r.amount !== undefined ? { amount: r.amount } : {}) }
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
    // One raw approve / setApprovalForAll(true): an approval of the spender it names.
    const grant = calls.length === 1 && !carriesForeignPayload(calls[0]) ? grantCall(calls[0]) : null
    if (grant) return approvalIntent(base, grant.spender, grant.token, grant.amount, undefined, isUnlimitedAllowance(grant.amount))
  }
  // An EVM, Solana or Tron transaction never goes to a `recipient` field (`transfer` options do):
  // showing it would name a destination the signed transaction does not have (round 3, H2).
  const ns = chain.split(':')[0]
  const noRecipient = method !== 'transfer' && (ns === 'eip155' || ns === 'solana' || ns === 'tron' || ns === 'ton' || ns === 'near')
  const to = str(a.to) ?? (noRecipient ? undefined : str(a.recipient))
  // A token transfer in calldata moves that token, not the native value next to it (round 3, M1).
  const move = tokenMove(ns ?? '', arg)
  const token = move?.token ?? (typeof a.token === 'string' ? a.token : undefined)
  const amount = move ? move.amount : big(a.amount ?? a.value)
  return { ...base, kind: 'send', message: false, ...(to !== undefined ? { to } : {}), ...(token !== undefined ? { token } : {}), ...(amount !== undefined ? { amount } : {}) }
}

/** One token transfer a write makes through a contract — an ERC-20 / TRC-20 `transfer`, a NEP-141 `ft_transfer(_call)` — as token and amount. */
function tokenMove(ns: string, arg: unknown): { token: string; amount: bigint | undefined } | undefined {
  if (Array.isArray(arg)) return undefined
  const a = obj(arg)
  if (ns === 'eip155') {
    const data = hexData(a.data)
    const t = data !== undefined ? erc20Transfer(data) : null
    return t && str(a.to) !== undefined ? { token: str(a.to)!, amount: t.amount } : undefined
  }
  if (ns === 'tron' && str(a.contractAddress) !== undefined) {
    // The calldata the node signs, by its selector bytes (scan 2026-10-27 F10): a colliding signature text is the same transfer.
    const data = tronCallData(a.functionSelector, a.parameters)
    const t = data !== undefined ? erc20Transfer(data) : null
    return t ? { token: str(a.contractAddress)!, amount: t.amount } : undefined
  }
  if (ns === 'near' && Array.isArray(a.actions) && a.actions.length === 1 && str(a.receiverId) !== undefined) {
    const call = obj(obj(a.actions[0]).functionCall)
    if (call.methodName !== 'ft_transfer' && call.methodName !== 'ft_transfer_call') return undefined
    try {
      const json = call.args instanceof Uint8Array ? String.fromCharCode(...call.args) : typeof call.args === 'string' ? call.args : JSON.stringify(call.args)
      return { token: str(a.receiverId)!, amount: big(obj(JSON.parse(json)).amount) }
    } catch {
      return { token: str(a.receiverId)!, amount: undefined }
    }
  }
  return undefined
}

/**
 * Wrap an account so every write passes the policies first. Reads are
 * untouched; every guarded method (see {@link isGuardedWrite}) that the
 * account has becomes: quote → fee cap (where the account can quote) →
 * allow/block lists (not for message signatures) → confirm → original call.
 * `signTransaction` is guarded like a send: a module that signs and
 * broadcasts on its own cannot skip the policies. Approvals (`approve`,
 * `signPermit`, EIP-2612 / Permit2 typed data, raw `approve` /
 * `setApprovalForAll(…, true)` calldata) are checked against the
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
 * passes it). Before any rule or `confirm`, the account's own network is
 * settled — an EVM account built without `chainId` reports "eip155:unknown"
 * until its first RPC call, so `getChainId()` is asked — and a write whose
 * account is on another network than `chain` (a namespace registration with
 * the RPC elsewhere) is refused with `PolicyViolationError('chain')`: confirm
 * would show one chain while the signature is for another. Short and
 * genesis spellings of one network match (see `sameChain`). An account that
 * cannot tell its network answers to the rules of `chain`.
 */
/** A signing account — what {@link applyPolicies} wraps: it has an address, a chain and a write method. */
export function isSigningAccount(v: unknown): v is IWalletAccount {
  const a = v as Record<string, unknown> | null
  return typeof a === 'object' && a !== null && typeof a.getAddress === 'function' && typeof a.chain === 'string' &&
    (typeof a.sign === 'function' || typeof a.sendTransaction === 'function' || typeof a.transfer === 'function')
}

/** A `Signer` (`sign(bytes)` signs anything, unchecked): never handed out through a policy wrapper. */
export function isSignerLike(v: unknown): boolean {
  const s = v as Record<string, unknown> | null
  return typeof s === 'object' && s !== null && typeof s.sign === 'function' && typeof s.curve === 'string'
}

/**
 * What a method behind a policy wrapper returns: a signing account comes back wrapped (`wrap`), a
 * signer not at all; a promise is mapped the same way once it settles. Anything else is as is.
 */
export function guardReturned(value: unknown, wrap: (account: IWalletAccount) => unknown): unknown {
  const map = (v: unknown) => {
    if (isSignerLike(v)) throw new PolicyViolationError('chain', 'A signer is not handed out through a policy-guarded object.')
    return isSigningAccount(v) ? wrap(v) : v
  }
  return value instanceof Promise ? value.then(map) : map(value)
}

export function applyPolicies<A extends IWalletAccount>(account: A, policies: Policies, chain?: string): A {
  const rules = [policies.maxFee, policies.allowlist, policies.blocklist]
  const hasRuleFor = (key: (k: string) => boolean) => rules.some((m) => m !== undefined && Object.keys(m).some(key))
  const guard = async (method: WriteMethod, arg: unknown) => {
    const ns = account.chain.split(':')[0]!
    // The network the write really goes to, before any rule, confirm or signature (audit #7): the
    // account's own and, for an EVM transaction that carries one, its chainId. An EVM account that
    // has not asked its RPC yet reports "eip155:unknown": learn its chain id — unless the write is
    // an off-chain signature (a message, valid on every network; typed data, whose domain chainId
    // the chain package judges, e.g. wallet-evm's `allowCrossChainTypedData`) and no rule needs it.
    const signed = signedChain(ns, method, arg)
    const known = isConcreteChain(account.chain) ? account.chain : undefined
    const offChain = chainFree(method)
    const exactRules = hasRuleFor((k) => k.includes(':') && canonicalNamespace(k.split(':')[0]!) === canonicalNamespace(ns))
    let learned: string | undefined
    const getChainId = (account as { getChainId?: () => Promise<number | bigint> }).getChainId
    // A message needs no chain id at all: no list or cap applies to it.
    const message = MESSAGE_METHODS.includes(method)
    const needed = !offChain || (!message && !isConcreteChain(chain) && exactRules)
    if (known === undefined && needed && typeof getChainId === 'function') {
      try {
        learned = `${ns}:${await getChainId.call(account)}`
      } catch (err) {
        // Only an account with no provider at all (it signs offline) is judged by the rules of
        // `chain`, as before; a provider that fails is no reason to skip the check.
        if (!isOffline(account)) throw err
      }
    }
    const own = known ?? learned
    if (!offChain) {
      // Asked for one network, signing on another (a namespace registration whose RPC is elsewhere,
      // a transaction for another chain id): confirm would show the wrong chain and the rules of
      // the wrong chain would judge it. Without `chain`, the account's own network is the one asked.
      const asked = isConcreteChain(chain) ? chain : own
      for (const c of [signed, own]) {
        if (c !== undefined && asked !== undefined && !sameChain(asked, c)) {
          throw new PolicyViolationError('chain', `This write signs for ${c}, not for ${asked} it was asked for; nothing was signed.`)
        }
      }
    }
    // The account's network is unknown and none was asked for: the namespace's own rules need no
    // chain id, but an exact rule of this family could be the account's — refuse rather than guess
    // (a chainId the write carries says what is signed, not which rules the account answers to).
    if (own === undefined && !isConcreteChain(chain) && exactRules && !message) {
      throw new PolicyViolationError('chain', `The account's chain is unknown (${account.chain}), so its policies cannot be applied.`)
    }
    // The rules of every network in play apply: the one asked for, the account's own, the one signed for.
    const chains = [...new Set([chain, own, signed].filter((c): c is string => c !== undefined && !c.endsWith(':unknown')))]
    // Every rule key that covers the asked-for chain or the account's own: its namespace and its
    // exact id, in whichever spelling the app wrote them (`solana:mainnet`, `tron:728126428`,
    // `bitcoin` for `bip122` — round 3, H4).
    const written = [...new Set(rules.flatMap((m) => (m ? Object.keys(m) : [])))]
    const keys = written.filter((k) => (chains.length > 0 ? chains.some((c) => ruleCovers(k, c)) : ruleCovers(k, ns)))
    const judged = chains[0] ?? account.chain
    const intent = intentOf(judged, await account.getAddress(), method, arg, { erc20: await approveRevokesErc20(judged, method, arg, account) })
    // An SPL transfer pays a token account: its owner is the recipient, and only the network knows
    // it. Read through the account when a list or confirm will look; unread → unknown (round 3, M1).
    const pending = PENDING_TOKEN_ACCOUNTS.get(intent)
    if (pending) {
      const judged = policies.confirm !== undefined || keys.some((k) => policies.allowlist?.[k] !== undefined || policies.blocklist?.[k] !== undefined)
      const read = (account as { getTokenAccountOwner?: (address: string) => Promise<string | undefined> }).getTokenAccountOwner
      for (const t of pending) {
        let owner: string | undefined
        if (judged && typeof read === 'function') { try { owner = await read.call(account, t) } catch { owner = undefined } }
        if (owner === undefined) { intent.destinations.push(t); intent.destinationUnknown = true } else if (!intent.destinations.includes(owner)) intent.destinations.push(owner)
      }
    }
    const caps = keys.flatMap((k) => { const cap = policies.maxFee?.[k]; return cap === undefined ? [] : [{ k, cap: BigInt(cap) }] })
    // A listed write that pays a fee but has nowhere to take a cap — NEAR's signBuilt, Solana's
    // signCompiled / signTransactionMessage — is refused under a fee cap rather than signed unchecked
    // (round 3, review and M8). Methods guarded only by their name never get here: they are refused.
    if (caps.length > 0 && CAPPED[method] === undefined && !FEE_FREE.includes(method)) {
      throw new PolicyViolationError('maxFee', `${method} has no fee the ${caps[0]!.k} cap can be checked against; nothing was signed.`)
    }
    if (caps.length > 0 && QUOTABLE.includes(method)) {
      const { fee } = method === 'transfer' ? await account.quoteTransfer(arg as TransferOptions) : await account.quoteSendTransaction(arg)
      for (const { k, cap } of caps) if (fee > cap) throw new PolicyViolationError('maxFee', `Fee ${fee} exceeds the ${k} cap of ${cap}.`)
    }
    // Addresses are compared in one canonical form per chain (EVM lowercase, Tron 41-hex, TON raw), both sides (scan F17).
    const listed = (k: string, list: string[] | undefined) => (list ? new Set(list.map((a) => canonicalAddress(k, a))) : undefined)
    if (intent.kind === 'revoke') {
      // Revoking takes rights away: the allowlist and the spender's listing do not apply.
      // The contract it calls must still not be blocklisted.
      for (const k of keys) {
        const block = listed(k, policies.blocklist?.[k])
        const hit = block && revokeTargets(intent).find((t) => block.has(canonicalAddress(k, t)))
        if (hit) throw new PolicyViolationError('blocklist', `Contract ${hit} is on the ${k} blocklist.`)
      }
    } else if (!intent.message) {
      // The spender of an approval, or a recipient / contract called (raw approval calldata has both).
      const what = (d: string | undefined) => (intent.kind === 'approval' && d !== undefined && d === intent.to ? 'Spender' : 'Destination')
      // Each matching allowlist must hold every destination (their intersection); any matching blocklist refuses (their union).
      for (const k of keys) {
        const allow = listed(k, policies.allowlist?.[k])
        if (allow) {
          const outside = intent.destinations.find((d) => !allow.has(canonicalAddress(k, d)))
          if (outside !== undefined || intent.destinations.length === 0 || intent.destinationUnknown) {
            throw new PolicyViolationError('allowlist', `${what(outside)} ${outside ?? '(unknown)'} is not on the ${k} allowlist.`)
          }
        }
        const block = listed(k, policies.blocklist?.[k])
        if (block) {
          const hit = intent.destinations.find((d) => block.has(canonicalAddress(k, d)))
          if (hit !== undefined) throw new PolicyViolationError('blocklist', `${what(hit)} ${hit} is on the ${k} blocklist.`)
          // Fail closed only when nobody else can look (scan F16); with a confirm hook it sees destinationUnknown.
          if (intent.destinationUnknown && !policies.confirm) throw new PolicyViolationError('blocklist', `Cannot tell every destination of this ${intent.method} on ${k}, and the ${k} blocklist is on with no confirm hook to ask.`)
        }
      }
    }
    // confirm gets its own copy of the argument: whatever it edits is not what gets signed (round 3, M2).
    if (policies.confirm && !(await policies.confirm({ ...intent, raw: snapshot(intent.raw) }))) throw new UserRejectedError('The write was not confirmed.')
    // The quote is an estimate: the account signs its own gas limit (with headroom) and fee fields.
    // Hand it the tightest cap so it checks the transaction it is about to sign (audit #4).
    return caps.length > 0 && CAPPED[method] !== undefined ? caps.reduce((a, b) => (b.cap < a.cap ? b : a)).cap : undefined
  }
  const wrapped = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const handler: ProxyHandler<A> = {
    get(target, prop, receiver) {
      // The signer signs whatever it is handed: reaching it would skip every rule (round 3, H3).
      if (prop === 'signer') return undefined
      // Getters run on the account itself, so none of them sees this wrapper.
      const v = Reflect.get(target, prop, target)
      if (isSignerLike(v)) return undefined
      // Modules read the account's RPC from `_config`: a copy, so nobody writes the account's settings through it.
      if (prop === '_config') return readOnlyConfig(v)
      if (typeof v !== 'function' || prop === 'constructor') return v
      if (typeof prop === 'string' && isGuardedWrite(prop)) {
        let fn = wrapped.get(prop)
        if (!fn && isUnlistedWrite(prop)) {
          // A chain package's internal helper (BTC signPlan pays its second argument while the plan
          // names another address): no intent the rules could judge, so it is not callable here (scan 2026-10-27 F1).
          fn = async () => { throw new PolicyViolationError('method', `${prop} is not a write the policies can check; nothing was signed.`) }
          wrapped.set(prop, fn)
        }
        if (!fn) {
          const original = v as (...args: unknown[]) => Promise<unknown>
          fn = async (...given: unknown[]) => {
            // One copy, taken before anything is judged, is what the rules see and what gets signed (round 3, M2).
            const args = snapshot(given)
            const maxFee = await guard(prop, args[0])
            if (maxFee !== undefined) {
              // WriteOptions sit at CAPPED[prop] (second, or third after sendSerialized's guard); a tighter caller cap stays.
              const at = CAPPED[prop]!
              const given = obj(args[at]) as WriteOptions
              const tighter = given.maxFee !== undefined && BigInt(given.maxFee) < maxFee ? BigInt(given.maxFee) : maxFee
              const next = [...args]
              while (next.length < at) next.push(undefined)
              next[at] = { ...given, maxFee: tighter }
              return original.apply(target, next)
            }
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
      // Reads run on the account itself. An account they hand back (NEAR's `withAccountId`, the
      // same key bound to a named account) answers to the same policies; the account itself comes
      // back as this wrapper (round 3, H3).
      const method = v as (...args: unknown[]) => unknown
      return (...args: unknown[]) => guardReturned(method.apply(target, args), (a) => (a === target ? receiver : applyPolicies(a, policies, chain)))
    },
    // The same view through descriptors and key listings: no signer, guarded methods, a copied `_config`.
    getOwnPropertyDescriptor(target, prop) {
      const d = Reflect.getOwnPropertyDescriptor(target, prop)
      if (!d || !d.configurable || !('value' in d)) return d
      if (prop === 'signer' || isSignerLike(d.value)) return undefined
      return { ...d, value: handler.get!(target, prop, proxy) }
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((k) => {
        const d = Reflect.getOwnPropertyDescriptor(target, k)
        return !d?.configurable || (k !== 'signer' && !isSignerLike(d.value))
      })
    },
    // Nothing is written to the account through its wrapper: not its methods, not its settings.
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
  }
  const proxy = new Proxy(account, handler)
  return proxy
}

/** A shallow copy of an account's `_config` (its provider list copied too), or the value as it is. */
function readOnlyConfig(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v
  const c = { ...(v as Record<string, unknown>) }
  if (Array.isArray(c.provider)) c.provider = [...(c.provider as unknown[])]
  return Object.freeze(c)
}
