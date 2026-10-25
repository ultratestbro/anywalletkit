import { describe, expect, it, vi } from 'vitest'
import { WalletManager, type FeeRates, type HistorySource, type IWalletAccount } from '@anywalletkit/core'
import { createMockAccount } from '@anywalletkit/conformance'
import { PolicyViolationError, Wallet, applyPolicies } from '../src/index.js'

// Regressions an independent review found in the 2026-10-25 audit fixes, pinned before the fix.
const SEED = 'test test test test test test test test test test test junk'
const EVIL = '0x00000000000000000000000000000000000E0E01'
const SPENDER = '0x0000000000000000000000000000000000005bE0'
const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')

describe('a one-call batch of approval calldata still checks the contract it calls', () => {
  const approve = { to: EVIL, value: 0n, data: `0x095ea7b3${pad(SPENDER)}${pad('5')}` }
  const operatorOn = { to: EVIL, value: 0n, data: `0xa22cb465${pad(SPENDER)}${pad('1')}` }
  for (const call of [approve, operatorOn]) {
    for (const method of ['sendTransaction', 'signTransaction'] as const) {
      it(`${method}([${call.data.slice(0, 10)}…])`, async () => {
        const acc = createMockAccount({ chain: 'eip155:1' })
        await expect(applyPolicies(acc, { blocklist: { 'eip155:1': [EVIL] } })[method]([call] as never)).rejects.toThrow(/blocklist/)
        await expect(applyPolicies(acc, { allowlist: { 'eip155:1': [SPENDER] } })[method]([call] as never)).rejects.toThrow(/allowlist/)
        expect(acc.sent).toHaveLength(0)
      })
    }
  }
})

describe('an EVM account that cannot learn its chain id still signs offline through the policies', () => {
  const offline = () => Object.assign(createMockAccount({ chain: 'eip155:unknown' }), {
    getChainId: async () => { throw new Error('The wallet must be connected to a provider to detect the chain id.') },
  })
  it('sign / signTransaction with confirm only, the asked-for chain given or not', async () => {
    const confirm = vi.fn(async () => true)
    const acc = offline()
    await expect(applyPolicies(acc, { confirm }, 'eip155:1').sign('hi')).resolves.toBeDefined()
    await expect(applyPolicies(acc, { confirm }).signTransaction({ to: SPENDER, value: 1n, chainId: 1 })).resolves.toBeDefined()
    expect(confirm).toHaveBeenCalledTimes(2)
  })
  it('exact rules of its family with no chain to pick still refuse (unchanged)', async () => {
    await expect(applyPolicies(offline(), { blocklist: { 'eip155:1': [EVIL] } }).signTransaction({ to: SPENDER, value: 1n })).rejects.toMatchObject({ policy: 'chain' })
  })
})

describe('one eip155 registration: reads on any EVM chain keep working, writes on the wrong chain are refused', () => {
  class OnEthereum extends WalletManager<IWalletAccount, Record<string, never>> {
    async getAccount() { return this.getAccountByPath() }
    async getAccountByPath() {
      const a = this._accounts.get('0') ?? createMockAccount({ chain: 'eip155:1', address: '0x00000000000000000000000000000000000000aa' })
      this._accounts.set('0', a)
      return a
    }
    async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 1n, fast: 1n } }
  }
  const source = (chain: string): HistorySource => ({
    chain,
    listActivity: async (address) => ({ items: [{ chain, hash: `0x${chain.slice(7).padStart(4, '0')}`, time: 100, status: 'confirmed', address, from: address, to: address, nativeValue: 0n, transfers: [] }] }),
    getTransaction: async () => undefined,
    explorerTxUrl: (h) => h,
  })

  it('history() lists every registered chain (the kit README pattern)', async () => {
    const errors: unknown[] = []
    const w = new Wallet(SEED, { activity: { onError: (e) => { errors.push(e) } } })
    w.registerWallet('eip155', OnEthereum, {})
    w.registerHistorySource(source('eip155:8453'))
    w.registerHistorySource(source('eip155:1'))
    const page = await w.history({ limit: 20 })
    expect(page.items.map((i) => i.chain).sort()).toEqual(['eip155:1', 'eip155:8453'])
    expect(errors).toEqual([])
  })

  it('getAccount on the other chain reads, and refuses to write, with or without policies', async () => {
    for (const w of [new Wallet(SEED), new Wallet(SEED, { policies: { confirm: async () => true } })]) {
      w.registerWallet('eip155', OnEthereum, {})
      const base = await w.getAccount('eip155:8453')
      expect(await base.getAddress()).toBe('0x00000000000000000000000000000000000000aa')
      await expect(base.sendTransaction({ to: SPENDER, value: 1n })).rejects.toBeInstanceOf(PolicyViolationError)
      await expect(base.sign('hi')).rejects.toMatchObject({ policy: 'chain' })
      const eth = await w.getAccount('eip155:1')
      await expect(eth.sendTransaction({ to: SPENDER, value: 1n })).resolves.toBeDefined()
    }
  })
})
