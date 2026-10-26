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
    // protected / private helpers that sign are named sign*, so the proxy guards them
    const btc = await w.getAccount('bip122:000000000019d6689c085ae165831e93') as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    await expect(btc.signSpend!({ to: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', value: 1000n })).rejects.toBeInstanceOf(UserRejectedError)
    await expect(btc.signPlan!({})).rejects.toBeInstanceOf(UserRejectedError)
    const zec = await w.getAccount('zcash:mainnet') as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    await expect(zec.signSpend!({ to: 't1abc', value: 1000n })).rejects.toBeInstanceOf(UserRejectedError)
    const ton = await w.getAccount('ton:-239') as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    await expect(ton.signMessages!([], undefined, 'transaction')).rejects.toBeInstanceOf(UserRejectedError)
    expect(confirm).toHaveBeenCalledTimes(6)
    w.dispose()
  })
})
