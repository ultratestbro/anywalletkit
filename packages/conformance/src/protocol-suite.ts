import { describe, expect, it } from 'vitest'
import { NotImplementedError, ReadOnlyAccountError, type IWalletAccount, type IWalletAccountReadOnly, type ProtocolType } from '@forgewallet/core'
import { createMockAccount } from './mock-account.js'

type AnyProtocol = Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor<P> = new (account: IWalletAccountReadOnly | IWalletAccount, config?: any) => P

/** Method names per protocol type: [writes, reads]. Writes must refuse a read-only account. */
const SURFACE: Record<ProtocolType, { writes: string[]; reads: string[] }> = {
  swap:      { writes: ['swap'], reads: ['quoteSwap'] },
  bridge:    { writes: ['bridge'], reads: ['quoteBridge'] },
  swidge:    { writes: ['swidge'], reads: ['quoteSwidge', 'getSwidgeStatus', 'getSupportedChains', 'getSupportedTokens'] },
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
  /** Account factory for reads; default: the recording mock. Use a fixture-backed one for real quote checks. */
  account?: () => IWalletAccount
  /** Constructor config, when the module requires one (e.g. swidge engines need `fromChain`). */
  config?: unknown
}

/** The conformance suite every protocol module must pass. */
export function describeProtocolModule<P extends object>(name: string, o: ProtocolSuiteOptions<P>): void {
  const { writes, reads } = SURFACE[o.type]!
  const skip = new Set(o.notImplemented ?? [])

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

    it('constructs with a read-only account and refuses writes with a clear error', async () => {
      const ro = createMockAccount().toReadOnlyAccount()
      const p = new o.Protocol(ro, o.config) as AnyProtocol
      for (const m of writes) {
        if (skip.has(m)) continue
        const args = o.samples?.[m] ?? [{}]
        await expect((p[m] as (...a: unknown[]) => Promise<unknown>)(...args)).rejects.toSatisfy(
          (e: unknown) => e instanceof ReadOnlyAccountError || /read-only|requires .* account/i.test(String((e as Error)?.message)),
        )
      }
    })

    it('reads and quotes never broadcast', async () => {
      const account = o.account?.() ?? createMockAccount()
      const p = new o.Protocol(account, o.config) as AnyProtocol
      for (const m of reads) {
        if (skip.has(m)) continue
        const args = o.samples?.[m]
        if (!args) continue
        try { await (p[m] as (...a: unknown[]) => Promise<unknown>)(...args) } catch { /* fixtures may be absent; we only assert no send */ }
      }
      const sent = (account as { sent?: unknown[] }).sent ?? []
      expect(sent, 'a quote/read called sendTransaction or transfer').toHaveLength(0)
    })
  })
}
