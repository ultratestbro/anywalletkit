import { UserRejectedError, type IWalletAccount, type TransferOptions } from '@forgewallet/core'

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
export type WriteMethod = KnownWriteMethod | (string & {})

export const GUARDED_WRITES: readonly KnownWriteMethod[] = [
  'sendTransaction', 'transfer', 'signTransaction', 'sign',
  'signTypedData', 'signPermit', 'approve',
  'signRaw', 'signNep413', 'signBuilt',
  'sendSerialized', 'signCompiled', 'signTransactionMessage',
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

/** What a policy sees before a write goes out. Amounts in base units when known. */
export interface WriteIntent {
  chain: string
  /** Account address the write originates from. */
  from: string
  method: WriteMethod
  kind: WriteKind
  /** Destination when it can be read off the call: recipient, called contract, or the SPENDER of an approval. */
  to?: string
  /** Token identifier for token transfers and approvals; undefined = native. */
  token?: string
  /** Amount when it can be read off the call (allowance for approvals). */
  amount?: bigint
  /** Approvals: the allowance is unbounded (uint256 / uint160 max, 2^255 and above, or a DAI-style `allowed`). */
  unlimited?: boolean
  /** Approvals / permits: expiry as given (unix seconds). */
  deadline?: bigint
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
  readonly policy: 'maxFee' | 'allowlist' | 'blocklist'
  constructor(policy: 'maxFee' | 'allowlist' | 'blocklist', message: string) {
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

function approvalIntent(base: Omit<WriteIntent, 'kind' | 'message'>, spender: string | undefined, token: string | undefined, amount: bigint | undefined, deadline: bigint | undefined, unlimited: boolean): WriteIntent {
  return {
    ...base, kind: 'approval', message: false,
    ...(spender !== undefined ? { to: spender } : {}), ...(token !== undefined ? { token } : {}),
    ...(amount !== undefined ? { amount } : {}), ...(deadline !== undefined ? { deadline } : {}), unlimited,
  }
}

/** EIP-712 input → approval intent for EIP-2612 `Permit` / Permit2, otherwise a confirm-only typed-data intent. */
function typedDataIntent(base: Omit<WriteIntent, 'kind' | 'message'>, arg: unknown): WriteIntent {
  const a = obj(arg)
  const domain = obj(a.domain)
  const message = obj(a.message)
  const types = obj(a.types)
  const primaryType = str(a.primaryType) ?? Object.keys(types).find((k) => k !== 'EIP712Domain')
  const verifying = str(domain.verifyingContract)
  if (primaryType === 'Permit' && str(message.spender) !== undefined) {
    // EIP-2612 (`value`) or DAI-style (`allowed: true`, no value) permit on the verifying contract (the token).
    const amount = big(message.value)
    const unlimited = message.allowed === true || unboundedAllowance(amount)
    return approvalIntent(base, str(message.spender), verifying, amount, big(message.deadline ?? message.expiry), unlimited)
  }
  if (primaryType !== undefined && PERMIT2_TYPES.has(primaryType) && str(message.spender) !== undefined) {
    const details = Array.isArray(message.details) ? obj(message.details[0]) : obj(message.details ?? message.permitted)
    const amount = big(details.amount)
    return approvalIntent(base, str(message.spender), str(details.token), amount, big(message.sigDeadline ?? message.deadline ?? details.expiration), unboundedAllowance(amount, MAX_UINT160))
  }
  return { ...base, kind: 'typedData', message: true, ...(verifying !== undefined ? { to: verifying } : {}) }
}

function intentOf(chain: string, from: string, method: WriteMethod, arg: unknown): WriteIntent {
  const base = { chain, from, method, raw: arg }
  const a = obj(arg)
  switch (method) {
    case 'approve': {
      const amount = big(a.amount)
      return approvalIntent(base, str(a.spender), str(a.token), amount, undefined, unboundedAllowance(amount))
    }
    case 'signPermit': {
      const amount = big(a.value ?? a.amount)
      return approvalIntent(base, str(a.spender), str(a.token), amount, big(a.deadline), unboundedAllowance(amount))
    }
    case 'signTypedData':
      return typedDataIntent(base, arg)
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
 * sees `kind: 'approval'` with `unlimited`.
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
  const guard = async (method: WriteMethod, arg: unknown) => {
    const chains = chainsOf()
    const intent = intentOf(chains[0] ?? account.chain, await account.getAddress(), method, arg)
    const caps = chains.flatMap((c) => { const cap = policies.maxFee?.[c]; return cap === undefined ? [] : [{ c, cap: BigInt(cap) }] })
    if (caps.length > 0 && QUOTABLE.includes(method)) {
      const { fee } = method === 'transfer' ? await account.quoteTransfer(arg as TransferOptions) : await account.quoteSendTransaction(arg)
      for (const { c, cap } of caps) if (fee > cap) throw new PolicyViolationError('maxFee', `Fee ${fee} exceeds the ${c} cap of ${cap}.`)
    }
    if (!intent.message) {
      const what = intent.kind === 'approval' ? 'Spender' : 'Destination'
      for (const c of chains) {
        const allow = policies.allowlist?.[c]
        if (allow && (intent.to === undefined || !allow.map(lower).includes(lower(intent.to)))) {
          throw new PolicyViolationError('allowlist', `${what} ${intent.to ?? '(unknown)'} is not on the ${c} allowlist.`)
        }
        const block = policies.blocklist?.[c]
        if (block && intent.to !== undefined && block.map(lower).includes(lower(intent.to))) {
          throw new PolicyViolationError('blocklist', `${what} ${intent.to} is on the ${c} blocklist.`)
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
