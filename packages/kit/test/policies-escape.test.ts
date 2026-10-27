import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { UserRejectedError, WalletManager, externalSigner, type IWalletAccount, type FeeRates } from '@anywalletkit/core'
import { WalletManagerBtc } from '@anywalletkit/wallet-btc'
import { WalletManagerNear } from '@anywalletkit/wallet-near'
import { WalletManagerTon } from '@anywalletkit/wallet-ton'
import { WalletManagerZcash } from '@anywalletkit/wallet-zcash'
import { Wallet, applyPolicies } from '../src/index.js'

// Audit 2026-10-25 round 3, H3: the policy proxy handed out ways to sign around itself — the raw
// `signer`, accounts that account methods return (NEAR's `withAccountId`), and the chain manager
// (`wallet.getManager(chain).getAccount / getNamedAccount / getAccountByPath`).

const SIGNER = externalSigner({ curve: 'ed25519', publicKey: new Uint8Array(32).fill(1), sign: async () => new Uint8Array(64) })

/** A NEAR-like account: `withAccountId` returns another signing account on the same key. */
function namedAccount(chain = 'near:mainnet', id = 'implicit') {
  const acc = Object.assign(createMockAccount({ chain, address: id }), {
    signer: SIGNER,
    withAccountId: (name: string) => namedAccount(chain, name),
    withAccountIdLater: async (name: string) => namedAccount(chain, name),
    self() { return this },
    describe: () => ({ kind: 'read' }),
  })
  return acc
}

class FakeManager extends WalletManager<IWalletAccount, object> {
  async getAccount(index = 0) { return this.cachedAccount(`m/${index}`, () => namedAccount('near:mainnet', `acct${index}`)) }
  async getAccountByPath(path: string) { return this.cachedAccount(path, () => namedAccount('near:mainnet', path)) }
  async getNamedAccount(name: string) { return namedAccount('near:mainnet', name) }
  async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 1n, fast: 1n } }
}

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('no signing path around the policy proxy', () => {
  it('the proxy hides the signer', async () => {
    const guarded = applyPolicies(namedAccount(), { confirm: async () => false }, 'near:mainnet') as unknown as { signer?: unknown }
    expect(guarded.signer).toBeUndefined()
  })

  it('accounts an account method returns answer to the same policies (sync and async)', async () => {
    const confirm = vi.fn(async () => false)
    const guarded = applyPolicies(namedAccount(), { confirm }, 'near:mainnet')
    const named = guarded.withAccountId('alice.near')
    await expect(named.sign('hi')).rejects.toBeInstanceOf(UserRejectedError)
    await expect((await guarded.withAccountIdLater('bob.near')).sign('hi')).rejects.toBeInstanceOf(UserRejectedError)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect((named as unknown as { signer?: unknown }).signer).toBeUndefined()
    // a method returning the account itself returns the guarded one, reads stay as they were
    expect(guarded.self()).toBe(guarded)
    expect(guarded.describe()).toEqual({ kind: 'read' })
  })

  it('wallet.getManager hands out guarded accounts and no seed or signer accessors', async () => {
    const confirm = vi.fn(async () => false)
    const w = new Wallet(PHRASE, { policies: { confirm } })
    w.registerWallet('near', FakeManager, {})
    const m = w.getManager<FakeManager>('near:mainnet')
    for (const acc of [await m.getAccount(0), await m.getAccountByPath("m/44'/397'/1'"), await m.getNamedAccount('alice.near')]) {
      await expect(acc.sign('hi')).rejects.toBeInstanceOf(UserRejectedError)
    }
    expect(confirm).toHaveBeenCalledTimes(3)
    const raw = m as unknown as Record<string, unknown>
    expect(raw.seedBytes).toBeUndefined()
    expect(raw.externalSigner).toBeUndefined()
    expect(raw._accounts).toBeUndefined()
    // the same account object as wallet.getAccount
    expect(await m.getAccount(0)).toBe(await w.getAccount('near:mainnet', 0))
    expect(await m.getFeeRates()).toEqual({ slow: 1n, normal: 1n, fast: 1n })
    w.dispose()
  })

  it('real chain accounts: NEAR named accounts, BTC / Zcash / TON signing helpers all go through the policies', async () => {
    const confirm = vi.fn(async () => false)
    const w = new Wallet(PHRASE, { policies: { confirm } })
    w.registerWallet('near', WalletManagerNear, { provider: 'http://127.0.0.1:1' })
    w.registerWallet('bip122', WalletManagerBtc, {})
    w.registerWallet('zcash', WalletManagerZcash, {})
    w.registerWallet('ton', WalletManagerTon, {})
    const near = await w.getAccount<InstanceType<typeof WalletManagerNear> extends { getAccount(i?: number): Promise<infer A> } ? A : never>('near:mainnet')
    const named = near.withAccountId('alice.near')
    const built = { signerId: 'alice.near', publicKey: named.publicKey, nonce: 1n, receiverId: 'drainer.near', blockHash: new Uint8Array(32), actions: [{ transfer: { deposit: 10n ** 24n } }] }
    await expect(named.signBuilt(built as never)).rejects.toBeInstanceOf(UserRejectedError)
    expect((near as unknown as { signer?: unknown }).signer).toBeUndefined()
    const viaManager = await w.getManager<WalletManagerNear>('near:mainnet').getNamedAccount('alice.near')
    await expect(viaManager.sign('x')).rejects.toBeInstanceOf(UserRejectedError)
    // The signing helpers are #private methods: there is nothing the proxy could hand out (scan 2026-10-27 F1).
    const btc = await w.getAccount('bip122:000000000019d6689c085ae165831e93') as unknown as Record<string, unknown>
    const zec = await w.getAccount('zcash:mainnet') as unknown as Record<string, unknown>
    const ton = await w.getAccount('ton:-239') as unknown as Record<string, unknown>
    for (const [a, name] of [[btc, 'signSpend'], [btc, 'signPlan'], [btc, 'signInputs'], [zec, 'signSpend'], [zec, 'signInputs'], [ton, 'signMessages']] as const) {
      expect([name, typeof a[name]]).toEqual([name, 'undefined'])
    }
    expect(confirm).toHaveBeenCalledTimes(2)
    w.dispose()
  })

  describe('review round: no way around the wrappers by reflection, writes or unknown helpers', () => {
    it('descriptors, key listings and writes show no signer and change nothing', () => {
      const raw = namedAccount()
      const guarded = applyPolicies(raw, { confirm: async () => false }, 'near:mainnet') as unknown as Record<string, unknown>
      expect(Object.getOwnPropertyDescriptor(guarded, 'signer')).toBeUndefined()
      expect(Object.keys(guarded)).not.toContain('signer')
      expect(Reflect.ownKeys(guarded)).not.toContain('signer')
      // an own method's descriptor is the guarded one
      const own = Object.getOwnPropertyDescriptor(guarded, 'sign')!.value as (m: string) => Promise<unknown>
      return expect(own('hi')).rejects.toBeInstanceOf(UserRejectedError).then(() => {
        expect(() => { guarded.signer = SIGNER }).toThrow(TypeError)
        expect(() => { guarded.sign = async () => 'forged' }).toThrow(TypeError)
        expect(() => Object.defineProperty(guarded, 'sign', { value: async () => 'forged' })).toThrow(TypeError)
        expect(() => { delete guarded.sign }).toThrow(TypeError)
        expect((raw as unknown as { signer: unknown }).signer).toBe(SIGNER)
      })
    })

    it('_config reads as a frozen copy', () => {
      const raw = Object.assign(createMockAccount({ chain: 'eip155:1' }), { _config: { provider: ['https://rpc.example'], simulate: true } })
      const guarded = applyPolicies(raw, {}, 'eip155:1') as unknown as { _config: { provider: string[]; simulate: boolean } }
      expect(guarded._config.provider).toEqual(['https://rpc.example'])
      expect(() => { guarded._config.simulate = false }).toThrow(TypeError)
      guarded._config.provider.push('https://evil.example')
      expect(raw._config).toEqual({ provider: ['https://rpc.example'], simulate: true })
    })

    it('a sign* helper outside the known write surface is refused, under a fee cap too', async () => {
      const raw = Object.assign(createMockAccount({ chain: 'eip155:1' }), { signPrepared: async () => '0xsigned', signHash: async () => '0xsig' })
      const guarded = applyPolicies(raw, { maxFee: { 'eip155:1': 1n } }, 'eip155:1')
      await expect(guarded.signPrepared()).rejects.toMatchObject({ policy: 'method' })
      await expect(guarded.signHash()).rejects.toMatchObject({ policy: 'method' })
      // the public, fee-checked surface still works
      await guarded.sign('hi')
    })

    it('getManager exposes only the public reads and account getters', async () => {
      const w = new Wallet(PHRASE, { policies: { confirm: async () => false } })
      w.registerWallet('near', FakeManager, {})
      const m = w.getManager<FakeManager>('near:mainnet') as unknown as Record<string, unknown>
      for (const k of ['cachedAccount', 'signerAccount', 'seedBytes', 'externalSigner', 'dispose', '_accounts', '_signer', '_config']) {
        expect([k, m[k]]).toEqual([k, undefined])
        expect([k, Object.getOwnPropertyDescriptor(m, k)]).toEqual([k, undefined])
      }
      expect(Reflect.ownKeys(m)).toEqual([])
      expect(() => { m.getAccount = async () => null }).toThrow(TypeError)
      // the prototype's methods, called on the wrapper, reach none of the manager's state
      const proto = Object.getPrototypeOf(m) as { cachedAccount: (k: string, f: () => unknown) => Promise<unknown> }
      await expect(proto.cachedAccount.call(m, 'm/0', () => ({}))).rejects.toThrow()
      w.dispose()
    })

    it('TON and NEAR: only the field the package builds from is the destination', async () => {
      const ton = createMockAccount({ chain: 'ton:-239' })
      await expect(applyPolicies(ton, { allowlist: { 'ton:-239': ['EQ-allowed'] } }, 'ton:-239').sendTransaction({ to: new String('EQ-drainer'), value: 1n, recipient: 'EQ-allowed' } as never)).rejects.toMatchObject({ policy: 'allowlist' })
      const near = createMockAccount({ chain: 'near:mainnet' })
      await expect(applyPolicies(near, { allowlist: { 'near:mainnet': ['ok.near'] } }, 'near:mainnet').sendTransaction({ receiverId: new String('drainer.near'), receiver: 'ok.near', actions: [] } as never)).rejects.toMatchObject({ policy: 'allowlist' })
      expect(ton.sent.length + near.sent.length).toBe(0)
    })
  })
})
