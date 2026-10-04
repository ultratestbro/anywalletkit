import { UserRejectedError, type IWalletAccount, type TransferOptions, type TransferResult } from '@forgewallet/core'

/** What a policy sees before a write goes out. Amounts in base units of the chain's native token when known. */
export interface WriteIntent {
  chain: string
  /** Account address the write originates from. */
  from: string
  method: 'sendTransaction' | 'transfer'
  /** Destination when it can be read off the call (`to` / `recipient`). */
  to?: string
  /** Token identifier for token transfers; undefined = native. */
  token?: string
  /** Amount when it can be read off the call. */
  amount?: bigint
  /** The raw argument, for policies that need more. */
  raw: unknown
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

function intentOf(chain: string, from: string, method: WriteIntent['method'], arg: unknown): WriteIntent {
  const a = (arg ?? {}) as Record<string, unknown>
  const to = typeof a.to === 'string' ? a.to : typeof a.recipient === 'string' ? a.recipient : undefined
  const rawAmount = a.amount ?? a.value
  const amount = typeof rawAmount === 'bigint' ? rawAmount : typeof rawAmount === 'number' || typeof rawAmount === 'string' ? BigInt(rawAmount) : undefined
  return { chain, from, method, ...(to !== undefined ? { to } : {}), ...(typeof a.token === 'string' ? { token: a.token } : {}), ...(amount !== undefined ? { amount } : {}), raw: arg }
}

/**
 * Wrap an account so every write passes the policies first. Reads and signing
 * are untouched; `sendTransaction` and `transfer` become: quote → fee cap →
 * allow/block lists → confirm → original call.
 */
export function applyPolicies<A extends IWalletAccount>(account: A, policies: Policies): A {
  const guard = async (method: WriteIntent['method'], arg: unknown, quote: () => Promise<{ fee: bigint }>) => {
    const intent = intentOf(account.chain, await account.getAddress(), method, arg)
    const cap = policies.maxFee?.[account.chain]
    if (cap !== undefined) {
      const { fee } = await quote()
      if (fee > BigInt(cap)) throw new PolicyViolationError('maxFee', `Fee ${fee} exceeds the ${account.chain} cap of ${cap}.`)
    }
    const allow = policies.allowlist?.[account.chain]
    if (allow && (intent.to === undefined || !allow.map(lower).includes(lower(intent.to)))) {
      throw new PolicyViolationError('allowlist', `Destination ${intent.to ?? '(unknown)'} is not on the ${account.chain} allowlist.`)
    }
    const block = policies.blocklist?.[account.chain]
    if (block && intent.to !== undefined && block.map(lower).includes(lower(intent.to))) {
      throw new PolicyViolationError('blocklist', `Destination ${intent.to} is on the ${account.chain} blocklist.`)
    }
    if (policies.confirm && !(await policies.confirm(intent))) throw new UserRejectedError('The write was not confirmed.')
  }
  return new Proxy(account, {
    get(target, prop, receiver) {
      if (prop === 'sendTransaction') {
        return async (tx: unknown): Promise<TransferResult> => {
          await guard('sendTransaction', tx, () => target.quoteSendTransaction(tx))
          return target.sendTransaction(tx)
        }
      }
      if (prop === 'transfer') {
        return async (o: TransferOptions): Promise<TransferResult> => {
          await guard('transfer', o, () => target.quoteTransfer(o))
          return target.transfer(o)
        }
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}
