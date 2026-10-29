import { describe, expect, it } from 'vitest'
import { LocalSigner, deriveSecp256k1, seedFromMnemonicSync, type IWalletAccount, type IWalletAccountReadOnly } from '@anywalletkit/core'
import { WalletManagerBtc } from '@anywalletkit/wallet-btc'
import { WalletManagerNear } from '@anywalletkit/wallet-near'
import { WalletManagerTon } from '@anywalletkit/wallet-ton'
import { WalletManagerTron } from '@anywalletkit/wallet-tron'
import { WalletManagerZcash } from '@anywalletkit/wallet-zcash'
import { Wallet, type ManagerClass } from '../src/index.js'

// Audit 2026-10-29 A1: a protocol module registered on a wallet without policies was handed the
// raw account, and `account.signer.key()` (TypeScript-private only) returned the 32-byte key — a
// copy that outlived dispose(). Modules now always get the restricted account, the signer is a
// private field of every chain account, and the local key is read by a module-scoped function.
// Offline: public test mnemonic, no provider, nothing is sent.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

/** A hostile module: tries every route to a signer or a key and copies what it finds. */
class Thief {
  loot: Record<string, string> = {}
  readonly account: Record<string | symbol, unknown>
  constructor(account: IWalletAccount | IWalletAccountReadOnly) {
    this.account = account as unknown as Record<string | symbol, unknown>
    const tryIt = (name: string, f: () => unknown) => {
      try {
        const v = f()
        if (v instanceof Uint8Array) this.loot[name] = hex(v.slice())
        else if (v !== undefined && v !== null) this.loot[name] = typeof v === 'object' ? `object:${v.constructor?.name}` : String(v).slice(0, 40)
      } catch (e) { this.loot[name] = `throw:${(e as Error).message.slice(0, 50)}` }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = account as any
    tryIt('account.signer', () => a.signer)
    tryIt('signer.key()', () => a.signer.key())
    tryIt('getOwnPropertyDescriptor(signer)', () => Object.getOwnPropertyDescriptor(a, 'signer')?.value)
    tryIt('Reflect.get(signer)', () => Reflect.get(a, 'signer'))
    tryIt('proto signer getter', () => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(a), 'signer')?.get?.call(a))
    for (const k of Reflect.ownKeys(a)) {
      try {
        const v = a[k]
        if (v && typeof v === 'object' && typeof v.sign === 'function') tryIt(`prop[${String(k)}]`, () => v)
      } catch { /* ignore */ }
    }
    for (const k of ['getSigner', 'keyPair', '_signer', 'wallet', '_keyPair', 'privateKey', '_privateKey', 'secretKey']) tryIt(`a.${k}`, () => (typeof a[k] === 'function' ? a[k]() : a[k]))
  }
}

const CASES: [string, string, ManagerClass<never, object>, object][] = [
  ['ton:-239', 'ton', WalletManagerTon as never, {}],
  ['bip122:000000000019d6689c085ae165831e93', 'bip122', WalletManagerBtc as never, {}],
  ['tron:mainnet', 'tron', WalletManagerTron as never, {}],
  ['near:mainnet', 'near', WalletManagerNear as never, {}],
  ['zcash:mainnet', 'zcash', WalletManagerZcash as never, {}],
]

const keyish = (loot: Record<string, string>) => Object.entries(loot).filter(([, v]) => /^[0-9a-f]{64}$/.test(v) || v.startsWith('object:'))

describe('audit 2026-10-29 A1: no module reaches a signer or a key', () => {
  for (const [chain, key, Manager, cfg] of CASES) {
    for (const policies of [undefined, {}]) {
      it(`${chain}, policies ${policies === undefined ? 'none' : '{}'}: nothing signer-like, the module still reads the account`, async () => {
        const w = new Wallet(SEED, policies === undefined ? {} : { policies })
        w.registerWallet(key, Manager, cfg)
        w.registerProtocol('thief', Thief, { chain })
        const t = await w.getProtocol<Thief>('thief')
        expect(keyish(t.loot)).toEqual([])
        expect(t.account.signer).toBeUndefined()
        expect(await (t.account.getAddress as () => Promise<string>)()).toBe(await (await w.getAccount(chain)).getAddress())
        w.dispose()
      })
    }
  }

  it('without policies the module gets a wrapper, the app its own account; neither exposes the signer', async () => {
    const w = new Wallet(SEED)
    w.registerWallet('ton', WalletManagerTon, {})
    w.registerProtocol('thief', Thief, { chain: 'ton:-239' })
    const own = await w.getAccount<IWalletAccount & { signerKind: string }>('ton:-239')
    const t = await w.getProtocol<Thief>('thief')
    expect(t.account).not.toBe(own)
    expect(Reflect.get(own, 'signer')).toBeUndefined()
    expect(Object.keys(own)).not.toContain('signer')
    expect(own.signerKind).toBe('seed')
    w.dispose()
  })

  it('LocalSigner has no key accessor in plain JS', () => {
    const seed = seedFromMnemonicSync(SEED)
    const s = LocalSigner.fromSeed(seed, 'secp256k1', "m/44'/60'/0'/0/0")
    const secret = hex(deriveSecp256k1(seed, "m/44'/60'/0'/0/0").privateKey)
    const loose = s as unknown as Record<string, unknown>
    expect(loose.key).toBeUndefined()
    expect(Object.getOwnPropertyNames(LocalSigner.prototype)).not.toContain('key')
    expect(JSON.stringify(s)).not.toContain(secret)
    expect(Object.values(s).map((v) => (v instanceof Uint8Array ? hex(v) : String(v)))).not.toContain(secret)
    s.dispose()
  })
})
