import { describe, expect, it, vi } from 'vitest'
import { UserRejectedError, WalletManager, type FeeRates, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferOptions } from '@forgewallet/core'
import { LendingProtocol } from '@forgewallet/core'
import { createMockAccount } from '@forgewallet/conformance'
import { PolicyViolationError, Wallet, applyPolicies } from '../src/index.js'

const SEED = 'test test test test test test test test test test test junk'

/** A chain package stand-in: hands out recording mock accounts. */
class FakeManager extends WalletManager<IWalletAccount, { chain: string; fee?: bigint }> {
  static built = 0
  constructor(seed: string | Signer, config: { chain: string; fee?: bigint }) { super(seed, config); FakeManager.built++ }
  async getAccount(index = 0) { return this.getAccountByPath(`m/${index}`) }
  async getAccountByPath(path: string) {
    let a = this._accounts.get(path)
    if (!a) { a = createMockAccount({ chain: this._config.chain, address: `addr-${this._config.chain}-${path}`, fee: this._config.fee ?? 100n }); this._accounts.set(path, a) }
    return a
  }
  async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 2n, fast: 3n } }
}
class FakeLending extends LendingProtocol<{ pool: string }> {
  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: { pool: string }) { super(account, config) }
  account() { return this._account }
  pool() { return this._config.pool }
}

describe('Wallet (kit)', () => {
  it('registers wallets by namespace or exact chain, builds managers lazily, caches accounts', async () => {
    FakeManager.built = 0
    const w = new Wallet(SEED)
    w.registerWallet('eip155', FakeManager, { chain: 'eip155:1' })
    w.registerWallet('solana:devnet', FakeManager, { chain: 'solana:devnet' })
    expect(FakeManager.built).toBe(0)
    const a = await w.getAccount('eip155:1')
    const b = await w.getAccount('eip155:137') // namespace match
    expect(FakeManager.built).toBe(1)
    expect(await a.getAddress()).toBe('addr-eip155:1-m/0')
    expect(await b.getAddress()).toBe(await a.getAddress())
    await expect(w.getAccount('ton:-239')).rejects.toThrow(/No wallet registered/)
    expect(() => w.registerWallet('eip155', FakeManager, { chain: 'x' })).toThrow(/already registered/)
    w.dispose()
  })

  it('getProtocol constructs the module over the account of its chain, once per name', async () => {
    const w = new Wallet(SEED)
    w.registerWallet('eip155', FakeManager, { chain: 'eip155:1' })
    w.registerProtocol('aave', FakeLending, { chain: 'eip155:1', config: { pool: '0xpool' } })
    const p = await w.getProtocol<FakeLending>('aave')
    expect(p.pool()).toBe('0xpool')
    expect(await (p.account() as IWalletAccount).getAddress()).toBe('addr-eip155:1-m/0')
    expect(await w.getProtocol('aave')).toBe(p)
    await expect(w.getProtocol('nope')).rejects.toThrow(/No protocol registered/)
    w.dispose()
  })

  it('dispose() disposes every manager account', async () => {
    const w = new Wallet(SEED)
    w.registerWallet('eip155', FakeManager, { chain: 'eip155:1' })
    const a = (await w.getAccount('eip155:1')) as ReturnType<typeof createMockAccount>
    w.dispose()
    expect(a.calls.some((c) => c.method === 'dispose')).toBe(true)
  })
})

describe('policies', () => {
  const dest = '0x000000000000000000000000000000000000bEEF'
  it('fee cap blocks before broadcast and leaves cheap writes alone', async () => {
    const acc = createMockAccount({ chain: 'eip155:1', fee: 500n })
    const guarded = applyPolicies(acc, { maxFee: { 'eip155:1': 100n } })
    await expect(guarded.transfer({ recipient: dest, amount: 1n })).rejects.toBeInstanceOf(PolicyViolationError)
    expect(acc.sent).toHaveLength(0)
    const ok = applyPolicies(acc, { maxFee: { 'eip155:1': 1_000n } })
    await ok.transfer({ recipient: dest, amount: 1n })
    expect(acc.sent).toHaveLength(1)
  })
  it('allowlist / blocklist by destination, case-insensitive', async () => {
    const acc = createMockAccount({ chain: 'eip155:1' })
    const allow = applyPolicies(acc, { allowlist: { 'eip155:1': [dest.toLowerCase()] } })
    await allow.sendTransaction({ to: dest, value: 1n })
    await expect(allow.sendTransaction({ to: '0x000000000000000000000000000000000000dEaD', value: 1n })).rejects.toThrow(/allowlist/)
    const block = applyPolicies(acc, { blocklist: { 'eip155:1': [dest] } })
    await expect(block.transfer({ recipient: dest, amount: 1n })).rejects.toThrow(/blocklist/)
    expect(acc.sent).toHaveLength(1)
  })
  it('confirm sees the intent and can reject', async () => {
    const acc = createMockAccount({ chain: 'eip155:1' })
    const confirm = vi.fn(async () => false)
    const guarded = applyPolicies(acc, { confirm })
    await expect(guarded.transfer({ token: 'USDT', recipient: dest, amount: 7n } satisfies TransferOptions)).rejects.toBeInstanceOf(UserRejectedError)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ chain: 'eip155:1', method: 'transfer', to: dest, token: 'USDT', amount: 7n }))
    expect(acc.sent).toHaveLength(0)
  })
  it('reads and signing bypass policies', async () => {
    const acc = createMockAccount({ chain: 'eip155:1' })
    const guarded = applyPolicies(acc, { confirm: async () => false })
    expect(await guarded.getBalance()).toBe(0n)
    expect(await guarded.sign('x')).toBe('0xsig')
    expect(guarded.chain).toBe('eip155:1')
  })
})
