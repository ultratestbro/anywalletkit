import { describe, expect, it, vi } from 'vitest'
import { UserRejectedError, WalletManager, type FeeRates, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferOptions } from '@forgewallet/core'
import { LendingProtocol } from '@forgewallet/core'
import { createMockAccount } from '@forgewallet/conformance'
import { PolicyViolationError, Wallet, applyPolicies, isGuardedWrite } from '../src/index.js'

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
  it('rules of the chain the account was asked for apply even while the account reports eip155:unknown', async () => {
    // An EVM account without `chainId` reports "eip155:unknown" until its first RPC call.
    const acc = createMockAccount({ chain: 'eip155:unknown', fee: 500n })
    const block = applyPolicies(acc, { blocklist: { 'eip155:1': [dest] } }, 'eip155:1')
    await expect(block.transfer({ recipient: dest, amount: 1n })).rejects.toThrow(/eip155:1 blocklist/)
    const cap = applyPolicies(acc, { maxFee: { 'eip155:1': 100n } }, 'eip155:1')
    await expect(cap.transfer({ recipient: dest, amount: 1n })).rejects.toBeInstanceOf(PolicyViolationError)
    expect(acc.sent).toHaveLength(0)
  })
  it('a mismatched account (namespace registration on another network) answers to the rules of both chains', async () => {
    const acc = createMockAccount({ chain: 'eip155:1' })
    const guarded = applyPolicies(acc, { blocklist: { 'eip155:8453': [dest] } }, 'eip155:8453')
    await expect(guarded.transfer({ recipient: dest, amount: 1n })).rejects.toThrow(/eip155:8453 blocklist/)
    const other = applyPolicies(acc, { blocklist: { 'eip155:1': [dest] } }, 'eip155:8453')
    await expect(other.transfer({ recipient: dest, amount: 1n })).rejects.toThrow(/eip155:1 blocklist/)
    expect(acc.sent).toHaveLength(0)
  })
  it('Wallet.getAccount hands the requested chain to the policies', async () => {
    class UnknownChainManager extends WalletManager<IWalletAccount, object> {
      async getAccount() { return createMockAccount({ chain: 'eip155:unknown' }) }
      async getAccountByPath() { return createMockAccount({ chain: 'eip155:unknown' }) }
      async getFeeRates() { return { slow: 0n, normal: 0n, fast: 0n } }
    }
    const w = new Wallet(SEED, { policies: { blocklist: { 'eip155:1': [dest] } } })
    w.registerWallet('eip155:1', UnknownChainManager, {})
    const eth = await w.getAccount('eip155:1')
    await expect(eth.transfer({ recipient: dest, amount: 1n })).rejects.toBeInstanceOf(PolicyViolationError)
  })
  it('confirm sees the intent and can reject', async () => {
    const acc = createMockAccount({ chain: 'eip155:1' })
    const confirm = vi.fn(async () => false)
    const guarded = applyPolicies(acc, { confirm })
    await expect(guarded.transfer({ token: 'USDT', recipient: dest, amount: 7n } satisfies TransferOptions)).rejects.toBeInstanceOf(UserRejectedError)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ chain: 'eip155:1', method: 'transfer', to: dest, token: 'USDT', amount: 7n }))
    expect(acc.sent).toHaveLength(0)
  })
  it('reads bypass policies; a message signature asks confirm only (no destination to allow-list)', async () => {
    const acc = createMockAccount({ chain: 'eip155:1' })
    const refuse = applyPolicies(acc, { confirm: async () => false })
    expect(await refuse.getBalance()).toBe(0n)
    expect(refuse.chain).toBe('eip155:1')
    await expect(refuse.sign('x')).rejects.toBeInstanceOf(UserRejectedError)
    const confirm = vi.fn(async () => true)
    const listed = applyPolicies(acc, { allowlist: { 'eip155:1': [dest] }, confirm })
    expect(await listed.sign('x')).toBe('0xsig')
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ method: 'sign', message: true }))
  })
  it('signTransaction is guarded like a send: fee cap, lists, confirm — a self-broadcasting module cannot skip them', async () => {
    const acc = createMockAccount({ chain: 'eip155:1', fee: 500n })
    await expect(applyPolicies(acc, { maxFee: { 'eip155:1': 100n } }).signTransaction({ to: dest, value: 1n })).rejects.toBeInstanceOf(PolicyViolationError)
    await expect(applyPolicies(acc, { allowlist: { 'eip155:1': ['0x000000000000000000000000000000000000dEaD'] } }).signTransaction({ to: dest, value: 1n })).rejects.toThrow(/allowlist/)
    const confirm = vi.fn(async () => true)
    expect(await applyPolicies(acc, { confirm }).signTransaction({ to: dest, value: 1n })).toBe('0xsigned')
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ method: 'signTransaction', to: dest, amount: 1n, message: false }))
  })
  it('chain-specific write surfaces (sendSerialized) are guarded when present; the wrapper is stable per method', async () => {
    const acc = Object.assign(createMockAccount({ chain: 'solana:mainnet' }), { sendSerialized: async (b64: string) => ({ hash: `sent:${b64}` }) })
    const confirm = vi.fn(async () => true)
    const guarded = applyPolicies(acc, { confirm }) as typeof acc
    expect(await guarded.sendSerialized('AAAA')).toEqual({ hash: 'sent:AAAA' })
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ method: 'sendSerialized', raw: 'AAAA' }))
    expect(guarded.sendSerialized).toBe(guarded.sendSerialized)
    await expect(applyPolicies(acc, { confirm: async () => false }).sendSerialized('AAAA')).rejects.toBeInstanceOf(UserRejectedError)
  })
})

describe('policies — every signing surface is guarded (2026-10-20 audit)', () => {
  const spender = '0x000000000000000000000000000000000000C0DE'
  const token = '0x00000000000000000000000000000000000070Ce'
  const unlimited = (1n << 256n) - 1n
  const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
  const evmLike = () => Object.assign(createMockAccount({ chain: 'eip155:1' }), {
    approve: async (o: { token: string; spender: string; amount: bigint }) => ({ hash: `approved:${o.spender}` }),
    signPermit: async (o: { token: string; spender: string; value: bigint; deadline: bigint }) => ({ v: 27, r: '0x', s: '0x', deadline: o.deadline }),
    signTypedData: async (_typed: unknown) => '0xtyped',
    revokeAll: async () => 'revoked',
    getNonceHint: async () => 1,
    signerName: async () => 'not a write',
  })

  it('approve: the spender is the destination, unlimited is flagged, confirm and the lists apply', async () => {
    const acc = evmLike()
    const confirm = vi.fn(async () => false)
    await expect(applyPolicies(acc, { confirm }).approve({ token, spender, amount: 1n << 255n })).rejects.toBeInstanceOf(UserRejectedError)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ method: 'approve', kind: 'approval', to: spender, token, unlimited: true, message: false }))
    await expect(applyPolicies(acc, { blocklist: { 'eip155:1': [spender] } }).approve({ token, spender, amount: 5n })).rejects.toThrow(/Spender .* blocklist/)
    await expect(applyPolicies(acc, { allowlist: { 'eip155:1': [token] } }).approve({ token, spender, amount: 5n })).rejects.toThrow(/allowlist/)
    expect(await applyPolicies(acc, { allowlist: { 'eip155:1': [spender] } }).approve({ token, spender, amount: 5n })).toEqual({ hash: `approved:${spender}` })
  })

  it('signPermit is an approval, not a message: lists see the spender, confirm sees the allowance', async () => {
    const acc = evmLike()
    const confirm = vi.fn(async () => true)
    await applyPolicies(acc, { confirm }).signPermit({ token, spender, value: unlimited, deadline: 1800000000n })
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ method: 'signPermit', kind: 'approval', to: spender, token, amount: unlimited, unlimited: true, deadline: 1800000000n, message: false }))
    await expect(applyPolicies(acc, { blocklist: { 'eip155:1': [spender] } }).signPermit({ token, spender, value: 1n, deadline: 1n })).rejects.toBeInstanceOf(PolicyViolationError)
    await expect(applyPolicies(acc, { confirm: async () => false }).signPermit({ token, spender, value: 1n, deadline: 1n })).rejects.toBeInstanceOf(UserRejectedError)
  })

  it('signTypedData: EIP-2612 Permit and Permit2 are approvals of the spender; other typed data is confirm-only', async () => {
    const acc = evmLike()
    const permit = { domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: token }, types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, primaryType: 'Permit', message: { owner: 'addr', spender, value: unlimited.toString(), nonce: 0, deadline: '1800000000' } }
    const confirm = vi.fn(async () => true)
    await applyPolicies(acc, { confirm }).signTypedData(permit)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ method: 'signTypedData', kind: 'approval', to: spender, token, amount: unlimited, unlimited: true, message: false }))
    await expect(applyPolicies(acc, { blocklist: { 'eip155:1': [spender] } }).signTypedData(permit)).rejects.toThrow(/Spender .* blocklist/)
    const dai = { ...permit, message: { holder: 'addr', spender, nonce: 0, expiry: 1800000000, allowed: true } }
    await applyPolicies(acc, { confirm }).signTypedData(dai)
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'approval', to: spender, unlimited: true }))
    const permit2Msg = { domain: { name: 'Permit2', chainId: 1, verifyingContract: permit2 }, types: { PermitSingle: [], PermitDetails: [] }, primaryType: 'PermitSingle', message: { details: { token, amount: ((1n << 160n) - 1n).toString(), expiration: 1800000000, nonce: 0 }, spender, sigDeadline: 1800000000 } }
    await expect(applyPolicies(acc, { blocklist: { 'eip155:1': [spender] } }).signTypedData(permit2Msg)).rejects.toBeInstanceOf(PolicyViolationError)
    await applyPolicies(acc, { confirm }).signTypedData(permit2Msg)
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'approval', to: spender, token, unlimited: true }))
    const order = { domain: { name: 'Exchange', chainId: 1, verifyingContract: permit2 }, types: { Order: [{ name: 'maker', type: 'address' }] }, primaryType: 'Order', message: { maker: 'addr' } }
    expect(await applyPolicies(acc, { allowlist: { 'eip155:1': [spender] }, confirm }).signTypedData(order)).toBe('0xtyped')
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'typedData', message: true, to: permit2 }))
    await expect(applyPolicies(acc, { confirm: async () => false }).signTypedData(order)).rejects.toBeInstanceOf(UserRejectedError)
  })

  it('guarded by name: sign*/send*/approve*/revoke*/transfer* methods of any chain package, reads untouched', async () => {
    const acc = Object.assign(createMockAccount({ chain: 'tron:mainnet' }), {
      signRaw: async (tx: unknown) => tx,
      signNep413: async () => ({ signature: 'sig' }),
      signBuilt: async (tx: { receiverId: string }) => ({ signed: tx.receiverId }),
      revokeAll: async () => 'revoked',
      sendBatch: async () => 'batched',
      getNonce: async () => 1,
      signerName: async () => 'read',
    })
    const refuse = applyPolicies(acc, { confirm: async () => false })
    const raw = { raw_data: { contract: [{ parameter: { value: { to_address: '41abc', amount: 10 } } }] } }
    await expect(refuse.signRaw(raw)).rejects.toBeInstanceOf(UserRejectedError)
    await expect(refuse.signBuilt({ receiverId: 'bob.near' })).rejects.toBeInstanceOf(UserRejectedError)
    await expect(refuse.signNep413()).rejects.toBeInstanceOf(UserRejectedError)
    await expect(refuse.revokeAll()).rejects.toBeInstanceOf(UserRejectedError)
    await expect(refuse.sendBatch()).rejects.toBeInstanceOf(UserRejectedError)
    expect(await refuse.getNonce()).toBe(1)
    expect(await refuse.signerName()).toBe('read')
    const confirm = vi.fn(async () => true)
    const ok = applyPolicies(acc, { confirm, blocklist: { 'tron:mainnet': ['41abc'] } })
    await expect(ok.signRaw(raw)).rejects.toThrow(/blocklist/)
    await ok.signBuilt({ receiverId: 'bob.near' })
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'signBuilt', kind: 'send', to: 'bob.near', message: false }))
    await ok.signNep413()
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'signNep413', kind: 'message', message: true }))
    expect(isGuardedWrite('sendTransaction') && isGuardedWrite('signFoo') && isGuardedWrite('approveToken') && isGuardedWrite('transferFrom')).toBe(true)
    expect(isGuardedWrite('signer') || isGuardedWrite('sendable') || isGuardedWrite('getBalance') || isGuardedWrite('quoteTransfer')).toBe(false)
  })

  it('one check per user action: a write the outer method issues internally is not confirmed twice', async () => {
    const base = createMockAccount({ chain: 'eip155:1' })
    const acc = Object.assign(base, {
      approve: async function (this: typeof base, o: { token: string; spender: string; amount: bigint }) {
        await this.sendTransaction({ to: o.token, value: 0n, data: '0xreset' })
        return this.sendTransaction({ to: o.token, value: 0n, data: '0xapprove' })
      },
    })
    const confirm = vi.fn(async () => true)
    await applyPolicies(acc, { confirm }).approve({ token, spender, amount: 1n })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ method: 'approve', kind: 'approval', to: spender }))
    expect(base.sent).toHaveLength(2)
  })
})
