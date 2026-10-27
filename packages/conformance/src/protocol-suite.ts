import { describe, expect, it } from 'vitest'
import { NotImplementedError, ReadOnlyAccountError, type IWalletAccount, type IWalletAccountReadOnly, type ProtocolType } from '@anywalletkit/core'
import { createMockAccount } from './mock-account.js'
import { describeActivitySuite, type ActivityFixtureJson } from './activity-suite.js'
import type { ProtocolCtor as Ctor } from './ctor.js'

type AnyProtocol = Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any

/** Method names per protocol type: [writes, reads]. Writes must refuse a read-only account. */
const SURFACE: Record<ProtocolType, { writes: string[]; reads: string[] }> = {
  swap:      { writes: ['swap'], reads: ['quoteSwap'] },
  bridge:    { writes: ['bridge'], reads: ['quoteBridge'] },
  swap2:    { writes: ['swap2'], reads: ['quoteSwap2', 'getSwap2Status', 'getSupportedChains', 'getSupportedTokens'] },
  lending:   { writes: ['supply', 'withdraw', 'borrow', 'repay'], reads: ['quoteSupply', 'quoteWithdraw', 'quoteBorrow', 'quoteRepay'] },
  staking:   { writes: ['stake', 'requestWithdrawal', 'claimWithdrawals'], reads: ['quoteStake', 'quoteRequestWithdrawal', 'quoteClaimWithdrawals', 'getWithdrawalRequests', 'getStakedBalance', 'getApr'] },
  approvals: { writes: ['revoke', 'revokeAll'], reads: ['getSupportedStandards', 'getApprovals', 'quoteRevoke'] },
  fiat:      { writes: ['buy', 'sell'], reads: ['quoteBuy', 'quoteSell', 'getTransactionDetail', 'getSupportedCryptoAssets', 'getSupportedFiatCurrencies', 'getSupportedCountries'] },
}

export interface ProtocolSuiteOptions<P> {
  type: ProtocolType
  Protocol: Ctor<P>
  /** Sample arguments per method, used to call `quote*`/reads and check they never send. Methods without a sample are only checked for presence. */
  samples?: Partial<Record<string, unknown[]>>
  /** Methods this module intentionally leaves unimplemented (must throw NotImplementedError). */
  notImplemented?: string[]
  /**
   * Methods the protocol itself has no use for (e.g. a staking protocol whose payouts settle
   * automatically has nothing to claim). They must still exist and throw a clear Error on every
   * account; they are excluded from the read-only check. Prefer `notImplemented` when the
   * operation exists in the protocol but the module has not built it yet.
   */
  unsupported?: string[]
  /** Account factory for reads; default: the recording mock. Use a fixture-backed one for real quote checks. */
  account?: () => IWalletAccount
  /**
   * Reads and quotes that must RESOLVE with their sample on `account` — an error fails the suite.
   * Every other read is lenient (fixtures may be absent): it may throw, but it may never sign or send.
   */
  mustResolve?: string[]
  /** Constructor config, when the module requires one (e.g. swap2 engines need `fromChain`). */
  config?: unknown
  /**
   * Recorded transactions the module must recognize through `describeActivity` (and ones it must
   * refuse). Required for every module in the registry: a wallet built on the SDK shows these as
   * "Supplied USDC · Aave v3" instead of "Contract call". Load them from `fixtures/activity/*.json`.
   */
  activity?: { fixtures: ActivityFixtureJson[]; negatives?: ActivityFixtureJson[] }
}

/** Account methods that sign or broadcast: none may run inside a read or a quote. */
const SIGNING_METHOD = /^(sign|send|transfer|approve|broadcast|revoke)/

/**
 * Wrap `account` so that every signing or broadcasting call is recorded — including one to a
 * method the account does not have (a quote that calls `signTypedData` on the plain mock would
 * otherwise fail with a TypeError and look like a missing fixture).
 */
export function watchSigning<A extends object>(account: A): { account: A; calls: string[] } {
  const calls: string[] = []
  const watched = new Proxy(account, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof prop !== 'string' || !SIGNING_METHOD.test(prop)) return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      return (...args: unknown[]) => {
        calls.push(prop)
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).apply(target, args) : Promise.reject(new Error(`${prop} is not available here`))
      }
    },
  })
  return { account: watched, calls }
}

/** The conformance suite every protocol module must pass. */
export function describeProtocolModule<P extends object>(name: string, o: ProtocolSuiteOptions<P>): void {
  const { writes, reads } = SURFACE[o.type]!
  const skip = new Set(o.notImplemented ?? [])
  const unsupported = new Set(o.unsupported ?? [])

  if (o.activity) describeActivitySuite(name, { Protocol: o.Protocol, config: o.config, ...o.activity })

  describe(`${name}: conformance (${o.type})`, () => {
    it('implements the full surface (every method is a function)', () => {
      const p = new o.Protocol(createMockAccount(), o.config) as AnyProtocol
      for (const m of [...writes, ...reads]) expect(typeof p[m], `${m} missing`).toBe('function')
    })

    it('methods declared notImplemented throw NotImplementedError, not undefined', async () => {
      const p = new o.Protocol(createMockAccount(), o.config) as AnyProtocol
      for (const m of skip) {
        await expect((p[m] as (...a: unknown[]) => Promise<unknown>)(...(o.samples?.[m] ?? [{}]))).rejects.toBeInstanceOf(NotImplementedError)
      }
    })

    it('unsupported methods throw a clear Error even with a signing account', async () => {
      const p = new o.Protocol(createMockAccount(), o.config) as AnyProtocol
      for (const m of unsupported) {
        await expect((p[m] as (...a: unknown[]) => Promise<unknown>)(...(o.samples?.[m] ?? [{}]))).rejects.toBeInstanceOf(Error)
      }
    })

    it('constructs with a read-only account and refuses writes with a clear error', async () => {
      const ro = createMockAccount().toReadOnlyAccount()
      const p = new o.Protocol(ro, o.config) as AnyProtocol
      for (const m of writes) {
        if (skip.has(m) || unsupported.has(m)) continue
        const args = o.samples?.[m] ?? [{}]
        await expect((p[m] as (...a: unknown[]) => Promise<unknown>)(...args)).rejects.toSatisfy(
          (e: unknown) => e instanceof ReadOnlyAccountError || /read-only|requires .* account/i.test(String((e as Error)?.message)),
        )
      }
    })

    it('reads and quotes never sign or broadcast', async () => {
      const base = o.account?.() ?? createMockAccount()
      const { account, calls } = watchSigning(base)
      const p = new o.Protocol(account, o.config) as AnyProtocol
      for (const m of reads) {
        if (skip.has(m) || unsupported.has(m)) continue
        const args = o.samples?.[m]
        if (!args) continue
        const before = calls.length
        // Lenient: fixtures may be absent (see mustResolve) — but a signature attempt before the error still counts.
        try { await (p[m] as (...a: unknown[]) => Promise<unknown>)(...args) } catch { /* checked below */ }
        expect(calls.slice(before), `${m} called ${calls.slice(before).join(', ')} on the account`).toEqual([])
      }
      const sent = (base as { sent?: unknown[] }).sent ?? []
      expect(sent, 'a quote/read called sendTransaction or transfer').toHaveLength(0)
    })

    if ((o.mustResolve ?? []).length > 0) {
      it('must-resolve reads and quotes succeed with their samples', async () => {
        const { account, calls } = watchSigning(o.account?.() ?? createMockAccount())
        const p = new o.Protocol(account, o.config) as AnyProtocol
        for (const m of o.mustResolve!) {
          const args = o.samples?.[m]
          expect(args, `mustResolve lists ${m} without a sample`).toBeDefined()
          await (p[m] as (...a: unknown[]) => Promise<unknown>)(...args!)
        }
        expect(calls, 'a must-resolve read signed or sent').toEqual([])
      })
    }
  })
}
