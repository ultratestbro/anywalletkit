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
  // A wallet-evm account built without provider: `_config` holds no provider, getChainId throws.
  const offline = () => Object.assign(createMockAccount({ chain: 'eip155:unknown' }), {
    _config: {},
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
      // an off-chain message is valid on every network: signed, as on main (fourth review, P2)
      await expect(base.sign('hi')).resolves.toBeDefined()
      const eth = await w.getAccount('eip155:1')
      await expect(eth.sendTransaction({ to: SPENDER, value: 1n })).resolves.toBeDefined()
    }
  })
})

describe('second review: the chain check reads what is signed and never fails open', () => {
  const TO = '0x000000000000000000000000000000000000bEEF'
  /** An eip155:unknown account; `provider` set = online (wallet-evm keeps it in `_config`). */
  const lazy = (opts: { provider?: unknown; chainId?: () => Promise<number> }) => {
    const getChainId = vi.fn(opts.chainId ?? (async () => 1))
    const acc = Object.assign(createMockAccount({ chain: 'eip155:unknown' }), {
      getChainId, signTypedData: async (_typed: unknown) => '0xtyped', _config: opts.provider === undefined ? {} : { provider: opts.provider },
    })
    return { acc, getChainId }
  }

  it('a provider that fails does not let a mismatch through: the write fails, confirm never sees it', async () => {
    const confirm = vi.fn(async () => true)
    const { acc } = lazy({ provider: 'https://rpc.example', chainId: async () => { throw new Error('fetch failed') } })
    await expect(applyPolicies(acc, { confirm }, 'eip155:8453').sendTransaction({ to: TO, value: 1n })).rejects.toThrow(/fetch failed/)
    expect(confirm).not.toHaveBeenCalled()
    expect(acc.sent).toHaveLength(0)
  })

  it('no provider at all (offline signing): judged by the asked-for chain, as before', async () => {
    const confirm = vi.fn(async () => true)
    const { acc } = lazy({ chainId: async () => { throw new Error('The wallet must be connected to a provider to detect the chain id.') } })
    await expect(applyPolicies(acc, { confirm }, 'eip155:1').sendTransaction({ to: TO, value: 1n })).resolves.toBeDefined()
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('a transaction is checked by its chainId and the account\'s own network; a typed-data domain is the account\'s to judge, with no RPC call', async () => {
    const { acc, getChainId } = lazy({ provider: 'https://rpc.example', chainId: async () => 8453 })
    const g = applyPolicies(acc, { confirm: async () => true }, 'eip155:8453')
    await expect(g.signTransaction({ to: TO, value: 1n, chainId: 1 })).rejects.toMatchObject({ policy: 'chain' })
    await expect(g.signTransaction({ to: TO, value: 1n, chainId: '0x2105' })).resolves.toBeDefined()
    expect(getChainId).toHaveBeenCalledTimes(2) // transactions learn the account's network (fourth review, P1)
    const typed = (chainId?: unknown) => ({ domain: { name: 'x', ...(chainId !== undefined ? { chainId } : {}) }, types: { M: [{ name: 'a', type: 'uint256' }] }, primaryType: 'M', message: { a: 1 } })
    // wallet-evm refuses a foreign domain chainId itself, unless the account opts in (allowCrossChainTypedData)
    await expect(g.signTypedData(typed(1))).resolves.toBeDefined()
    await expect(g.signTypedData(typed('8453'))).resolves.toBeDefined()
    expect(getChainId).toHaveBeenCalledTimes(2)
  })

  it('off-chain messages valid on every network ask no RPC: sign, typed data without a chainId', async () => {
    const { acc, getChainId } = lazy({ provider: 'https://rpc.example', chainId: () => new Promise(() => undefined) })
    const g = applyPolicies(acc, { confirm: async () => true }, 'eip155:8453')
    await expect(g.sign('hi')).resolves.toBeDefined()
    await expect(g.signTypedData({ domain: { name: 'x' }, types: { M: [{ name: 'a', type: 'uint256' }] }, primaryType: 'M', message: { a: 1 } })).resolves.toBeDefined()
    expect(getChainId).not.toHaveBeenCalled()
  })

  it('exact rules with no chain to pick: typed data learns the chain id (its lists may apply), a message signs without asking', async () => {
    const { acc, getChainId } = lazy({ provider: 'https://rpc.example' })
    const g = applyPolicies(acc, { blocklist: { 'eip155:1': [EVIL] } })
    await expect(g.sign('hi')).resolves.toBeDefined()
    expect(getChainId).not.toHaveBeenCalled()
    // Typed data the policies cannot read is refused under a blocklist with no confirm hook (scan 2026-10-28 F7)…
    await expect(g.signTypedData({ domain: { name: 'x' }, types: { M: [{ name: 'a', type: 'uint256' }] }, primaryType: 'M', message: { a: 1 } })).rejects.toThrow(/Cannot tell every destination/)
    expect(getChainId).toHaveBeenCalledOnce()
    // …and goes to confirm when there is one.
    const c = applyPolicies(acc, { blocklist: { 'eip155:1': [EVIL] }, confirm: async () => true })
    await expect(c.signTypedData({ domain: { name: 'x' }, types: { M: [{ name: 'a', type: 'uint256' }] }, primaryType: 'M', message: { a: 1 } })).resolves.toBeDefined()
  })

  it('getAccount hands out the same object for the same account and chain', async () => {
    class Lazy extends WalletManager<IWalletAccount, Record<string, never>> {
      async getAccount() { return this.getAccountByPath() }
      async getAccountByPath() { const a = this._accounts.get('0') ?? lazy({ provider: 'x' }).acc; this._accounts.set('0', a); return a }
      async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 1n, fast: 1n } }
    }
    for (const w of [new Wallet(SEED), new Wallet(SEED, { policies: { confirm: async () => true } })]) {
      w.registerWallet('eip155', Lazy, {})
      expect(await w.getAccount('eip155:8453')).toBe(await w.getAccount('eip155:8453'))
      expect(await w.getAccount('eip155:8453')).not.toBe(await w.getAccount('eip155:1'))
    }
  })
})

describe('third review: the account opts into cross-chain typed data; rules of every chain in play apply', () => {
  const TO = '0x000000000000000000000000000000000000bEEF'
  const typed = (chainId: unknown, spender = SPENDER) => ({
    domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: '0x000000000000000000000000000000000000c0de' },
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit', message: { owner: TO, spender, value: '1000000000000000000000000000000', nonce: 0, deadline: 1 },
  })
  const evmAccount = (chain = 'eip155:42161') => Object.assign(createMockAccount({ chain }), { signTypedData: vi.fn(async (_typed: unknown) => '0xtyped') })

  it('typed data for another domain chainId is the account\'s call (allowCrossChainTypedData), not a chain mismatch', async () => {
    const acc = evmAccount()
    // Hyperliquid's "Exchange" domain: chainId 1337, signed from Arbitrum
    await expect(applyPolicies(acc, { confirm: async () => true }, 'eip155:42161').signTypedData({ ...typed(1337), primaryType: 'Agent', types: { Agent: [{ name: 'source', type: 'string' }] }, message: { source: 'a' } })).resolves.toBe('0xtyped')
  })

  it('without `chain`, the account\'s own rules judge typed data whatever its domain chainId', async () => {
    const acc = evmAccount('eip155:1')
    await expect(applyPolicies(acc, { blocklist: { 'eip155:1': [SPENDER] } }).signTypedData(typed(8453))).rejects.toThrow(/eip155:1 blocklist/)
    expect(acc.signTypedData).not.toHaveBeenCalled()
  })

  it('without `chain`, a transaction for another chain id than the account\'s is refused, and the account\'s rules still apply', async () => {
    const acc = createMockAccount({ chain: 'eip155:1' })
    await expect(applyPolicies(acc, { maxFee: { 'eip155:1': 0n } }).sendTransaction({ to: TO, value: 1n, chainId: 8453 })).rejects.toBeInstanceOf(PolicyViolationError)
    await expect(applyPolicies(acc, { allowlist: { 'eip155:8453': [TO] } }).sendTransaction({ to: TO, value: 1n, chainId: 8453 })).rejects.toMatchObject({ policy: 'chain' })
    expect(acc.sent).toHaveLength(0)
  })

  it('a no-policy wallet keeps handing out the same object once the account learns its chain', async () => {
    let chain = 'eip155:unknown'
    const acc = Object.assign(createMockAccount({ chain: 'eip155:unknown' }), { getChainId: async () => { chain = 'eip155:1'; return 1 } })
    Object.defineProperty(acc, 'chain', { get: () => chain })
    class Learns extends WalletManager<IWalletAccount, Record<string, never>> {
      async getAccount() { return this.getAccountByPath() }
      async getAccountByPath() { return acc }
      async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 1n, fast: 1n } }
    }
    const w = new Wallet(SEED)
    w.registerWallet('eip155', Learns, {})
    const a = await w.getAccount('eip155:1')
    await acc.getChainId()
    expect(await w.getAccount('eip155:1')).toBe(a)
  })
})

describe('fourth review: a transaction\'s chainId never hides the account\'s own network; messages are not chain-checked', () => {
  const TO = '0x000000000000000000000000000000000000bEEF'
  it('P1: without `chain`, a lazy account learns its network even when the transaction carries a chainId', async () => {
    const getChainId = vi.fn(async () => 1)
    const acc = Object.assign(createMockAccount({ chain: 'eip155:unknown' }), { getChainId, _config: { provider: 'x' } })
    await expect(applyPolicies(acc, { maxFee: { 'eip155:1': 0n } }).sendTransaction({ to: TO, value: 1n, chainId: 8453 })).rejects.toMatchObject({ policy: 'chain' })
    expect(getChainId).toHaveBeenCalled()
    // the same transaction for its own chain: the account's rules judge it
    await expect(applyPolicies(acc, { maxFee: { 'eip155:1': 0n } }).sendTransaction({ to: TO, value: 1n, chainId: 1 })).rejects.toMatchObject({ policy: 'maxFee' })
    expect(acc.sent).toHaveLength(0)
  })

  it('P1: an offline account with exact rules and no `chain` is refused even when the transaction names a chain', async () => {
    const acc = Object.assign(createMockAccount({ chain: 'eip155:unknown' }), { _config: {}, getChainId: async () => { throw new Error('no provider') } })
    await expect(applyPolicies(acc, { blocklist: { 'eip155:1': [EVIL] } }).signTransaction({ to: TO, value: 1n, chainId: 8453 })).rejects.toMatchObject({ policy: 'chain' })
  })

  it('P2: messages and typed data on an account of another network sign whatever the call order; transactions do not', async () => {
    const acc = Object.assign(createMockAccount({ chain: 'eip155:1' }), { signTypedData: async (_t: unknown) => '0xtyped' })
    for (const policies of [{}, { confirm: async () => true }]) {
      const g = applyPolicies(acc, policies, 'eip155:8453')
      await expect(g.sign('Sign in to example.org')).resolves.toBeDefined()
      await expect(g.signTypedData({ domain: { name: 'x' }, types: { M: [{ name: 'a', type: 'uint256' }] }, primaryType: 'M', message: { a: 1 } })).resolves.toBe('0xtyped')
      await expect(g.sendTransaction({ to: TO, value: 1n })).rejects.toMatchObject({ policy: 'chain' })
    }
  })
})

describe('fifth review: off-chain signatures with exact rules and no concrete chain asked (the keyring recipe)', () => {
  const typed = { domain: { name: 'x' }, types: { M: [{ name: 'a', type: 'uint256' }] }, primaryType: 'M', message: { a: 1 } }
  const lazyAcc = () => {
    const getChainId = vi.fn(async () => 1)
    return Object.assign(createMockAccount({ chain: 'eip155:unknown' }), { getChainId, _config: { provider: 'x' }, signTypedData: async (_t: unknown) => '0xtyped' })
  }
  for (const asked of ['eip155:unknown', 'eip155', undefined]) {
    it(`applyPolicies(acc, rules, ${String(asked)}): sign and signTypedData learn the chain and sign`, async () => {
      const acc = lazyAcc()
      const g = applyPolicies(acc, { maxFee: { 'eip155:1': 10n ** 16n }, confirm: async () => true }, asked)
      await expect(g.sign('hi')).resolves.toBeDefined()
      await expect(g.signTypedData(typed)).resolves.toBe('0xtyped')
    })
  }
  it('a plain message is never refused for an unknown chain: no list or cap applies to it', async () => {
    const offline = Object.assign(createMockAccount({ chain: 'eip155:unknown' }), { _config: {}, getChainId: async () => { throw new Error('no provider') } })
    await expect(applyPolicies(offline, { blocklist: { 'eip155:1': [EVIL] } }, 'eip155').sign('hi')).resolves.toBeDefined()
  })
  it('Wallet.getAccount(\'eip155\') with an eip155:1 cap signs a message', async () => {
    class Lazy extends WalletManager<IWalletAccount, Record<string, never>> {
      async getAccount() { return this.getAccountByPath() }
      async getAccountByPath() { const a = this._accounts.get('0') ?? lazyAcc(); this._accounts.set('0', a); return a }
      async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 1n, fast: 1n } }
    }
    const w = new Wallet(SEED, { policies: { maxFee: { 'eip155:1': 1n } } })
    w.registerWallet('eip155', Lazy, {})
    await expect((await w.getAccount('eip155')).sign('hi')).resolves.toBeDefined()
  })
})

