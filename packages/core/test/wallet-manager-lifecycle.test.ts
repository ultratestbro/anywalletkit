import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { LocalSigner, WalletManager, seedFromMnemonicSync, type FeeRates, type IWalletAccount, type Signer } from '../src/index.js'

const SEED = seedFromMnemonicSync('test test test test test test test test test test test junk')
const BASE = "m/44'/60'/0'/0"
const digest = sha256(new TextEncoder().encode('lifecycle'))

/** Minimal chain manager: accounts are the leaf signer plus a dispose hook. */
type Acc = IWalletAccount & { leaf: Signer }
class Manager extends WalletManager<Acc, { fail?: boolean }> {
  async getAccount(index = 0) { return this.getAccountByPath(`${BASE}/${index}`) }
  async getAccountByPath(path: string) {
    const s = this.externalSigner()!
    return this.signerAccount(path, s, path.slice(BASE.length + 1), (leaf) => {
      if (this._config.fail) throw new Error('chain refused the key')
      return { leaf, dispose: () => leaf.dispose() } as unknown as Acc
    })
  }
  async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 1n, fast: 1n } }
}

/** A seed signer that counts derivations and remembers each child. */
function counting() {
  const root = LocalSigner.fromSeed(SEED, 'secp256k1', BASE)
  const children: Signer[] = []
  const deriveLeaf = async (rel: string) => { const c = await root.deriveLeaf(rel); children.push(c); return c }
  return { signer: Object.assign(Object.create(root) as LocalSigner, { deriveLeaf }), children }
}

describe('WalletManager account lifecycle (audit 2026-10-25, #3)', () => {
  it('concurrent calls for one path derive once and share the account', async () => {
    const { signer, children } = counting()
    const m = new Manager(signer, {})
    const [a, b, c] = await Promise.all([m.getAccount(2), m.getAccount(2), m.getAccount(2)])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(children).toHaveLength(1)
  })

  it('a child whose account cannot be built is disposed, not leaked', async () => {
    const { signer, children } = counting()
    const m = new Manager(signer, { fail: true })
    await expect(m.getAccount(1)).rejects.toThrow('chain refused the key')
    expect(children).toHaveLength(1)
    await expect(children[0]!.sign(digest)).rejects.toThrow()
  })

  it('an account finished after dispose() is disposed and never returned', async () => {
    const { signer, children } = counting()
    const m = new Manager(signer, {})
    const pending = m.getAccount(3)
    m.dispose()
    await expect(pending).rejects.toThrow(/disposed/)
    expect(children).toHaveLength(1)
    await expect(children[0]!.sign(digest)).rejects.toThrow()
    await expect(m.getAccount(0)).rejects.toThrow(/disposed/)
  })
})
