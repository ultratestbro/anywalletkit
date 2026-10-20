import { UserRejectedError, type IWalletAccount, type TransferOptions } from '@forgewallet/core'

/**
 * Account methods the policies guard. Everything that produces a signature or
 * a broadcast: the `IWalletAccount` contract (`sendTransaction`, `transfer`,
 * `signTransaction`, `sign`) plus the chain-specific write surfaces an account
 * may add (Solana's `sendSerialized` / `signCompiled` /
 * `signTransactionMessage`). A module that signs and broadcasts by itself
 * still passes through here, because it can only do so through the account.
 */
export type WriteMethod = 'sendTransaction' | 'transfer' | 'signTransaction' | 'sign' | 'sendSerialized' | 'signCompiled' | 'signTransactionMessage'

export const GUARDED_WRITES: readonly WriteMethod[] = ['sendTransaction', 'transfer', 'signTransaction', 'sign', 'sendSerialized', 'signCompiled', 'signTransactionMessage']

/** Methods whose fee the account can quote up front (`maxFee` applies). */
const QUOTABLE: readonly WriteMethod[] = ['sendTransaction', 'transfer', 'signTransaction']

/** What a policy sees before a write goes out. Amounts in base units of the chain's native token when known. */
export interface WriteIntent {
  chain: string
  /** Account address the write originates from. */
  from: string
  method: WriteMethod
  /** Destination when it can be read off the call (`to` / `recipient`). */
  to?: string
  /** Token identifier for token transfers; undefined = native. */
  token?: string
  /** Amount when it can be read off the call. */
  amount?: bigint
  /** The raw argument (first argument of the call), for policies that need more. */
  raw: unknown
  /** `sign` is a message signature: nothing moves, allow/block lists do not apply, only `confirm`. */
  message: boolean
}

export interface Policies {
  /** Per-chain fee cap in native base units; a quote above it throws before broadcast. */
  maxFee?: Record<string, bigint | number>
  /** Per-chain allowlist of destinations (case-insensitive). Writes to anything else throw. */
  allowlist?: Record<string, string[]>
  /** Per-chain blocklist of destinations. */
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

function intentOf(chain: string, from: string, method: WriteMethod, arg: unknown): WriteIntent {
  const a = (typeof arg === 'object' && arg !== null ? arg : {}) as Record<string, unknown>
  const to = typeof a.to === 'string' ? a.to : typeof a.recipient === 'string' ? a.recipient : undefined
  const rawAmount = a.amount ?? a.value
  const amount = typeof rawAmount === 'bigint' ? rawAmount : typeof rawAmount === 'number' || (typeof rawAmount === 'string' && /^\d+$/.test(rawAmount)) ? BigInt(rawAmount) : undefined
  return { chain, from, method, ...(to !== undefined ? { to } : {}), ...(typeof a.token === 'string' ? { token: a.token } : {}), ...(amount !== undefined ? { amount } : {}), raw: arg, message: method === 'sign' }
}

/**
 * Wrap an account so every write passes the policies first. Reads are
 * untouched; every method in {@link GUARDED_WRITES} that the account has
 * becomes: quote → fee cap (where the account can quote) → allow/block lists
 * (not for message signatures) → confirm → original call. `signTransaction`
 * is guarded like a send: a module that signs and broadcasts on its own
 * cannot skip the policies.
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
      for (const c of chains) {
        const allow = policies.allowlist?.[c]
        if (allow && (intent.to === undefined || !allow.map(lower).includes(lower(intent.to)))) {
          throw new PolicyViolationError('allowlist', `Destination ${intent.to ?? '(unknown)'} is not on the ${c} allowlist.`)
        }
        const block = policies.blocklist?.[c]
        if (block && intent.to !== undefined && block.map(lower).includes(lower(intent.to))) {
          throw new PolicyViolationError('blocklist', `Destination ${intent.to} is on the ${c} blocklist.`)
        }
      }
    }
    if (policies.confirm && !(await policies.confirm(intent))) throw new UserRejectedError('The write was not confirmed.')
  }
  const wrapped = new Map<WriteMethod, (...args: unknown[]) => Promise<unknown>>()
  return new Proxy(account, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (typeof v !== 'function') return v
      if (typeof prop === 'string' && (GUARDED_WRITES as readonly string[]).includes(prop)) {
        const method = prop as WriteMethod
        let fn = wrapped.get(method)
        if (!fn) {
          const original = v as (...args: unknown[]) => Promise<unknown>
          fn = async (...args: unknown[]) => {
            await guard(method, args[0])
            return original.apply(target, args)
          }
          wrapped.set(method, fn)
        }
        return fn
      }
      return v.bind(target)
    },
  })
}
