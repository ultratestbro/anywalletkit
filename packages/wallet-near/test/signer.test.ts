import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { LocalSigner, SignerError, UserRejectedError, deriveEd25519, externalSigner, seedFromMnemonicSync } from '@anywalletkit/core'
import { NEAR_BASE_PATH, WalletAccountNear, WalletManagerNear, type NearFetch } from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ACCOUNT0 = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'

/** A "hardware wallet" holding the account-0 key outside the SDK. */
function hardwareWallet(reject = false) {
  const { privateKey, publicKey } = deriveEd25519(seedFromMnemonicSync(SEED), `${NEAR_BASE_PATH}/0'`)
  const contexts: string[] = []
  const signer = externalSigner({
    curve: 'ed25519',
    publicKey,
    sign: async (payload, o) => {
      contexts.push(o.context ?? '')
      if (reject) throw new UserRejectedError()
      return ed25519.sign(payload, privateKey)
    },
  })
  return { signer, contexts, publicKey }
}

function fakeNode() {
  const sent: string[] = []
  const fetch: NearFetch = async (method, params) => {
    const p = params as Record<string, unknown>
    if (method === 'gas_price') return { gas_price: '100000000' }
    if (method === 'block') return { header: { hash: '11111111111111111111111111111111' } }
    if (method === 'query' && p.request_type === 'view_account') return { amount: '5000000000000000000000000', locked: '0', storage_usage: 182 }
    if (method === 'query' && p.request_type === 'view_access_key') return { nonce: 1, permission: 'FullAccess' }
    if (method === 'send_tx') { sent.push(p.signed_tx_base64 as string); return { status: { SuccessValue: '' }, transaction: { hash: 'H' } } }
    throw new Error(`unmocked ${method}`)
  }
  return { fetch, sent }
}

describe('WalletManagerNear with an external signer', () => {
  it('builds the account at the signer key; a transfer and a message are signed through it', async () => {
    const f = fakeNode()
    const { signer, contexts } = hardwareWallet()
    const m = new WalletManagerNear(signer, { provider: f.fetch })
    const a = await m.getAccount(0)
    expect(a.address).toBe(ACCOUNT0)
    expect(a.path).toBe('external')
    expect(a.signer).toBe(signer)
    expect(await m.getAccount()).toBe(a)
    const res = await a.transfer({ recipient: 'alice.near', amount: 1n })
    expect(res.hash).toBe('H')
    expect(f.sent).toHaveLength(1)
    expect(await a.verify('hello', await a.sign('hello'))).toBe(true)
    expect(contexts).toEqual(['near-tx', 'near-message'])
    m.dispose()
  })

  it('refuses other indexes/paths, the wrong curve, and surfaces UserRejectedError', async () => {
    const m = new WalletManagerNear(hardwareWallet().signer)
    await expect(m.getAccount(1)).rejects.toThrow(/one account/)
    await expect(m.getAccountByPath("3'")).rejects.toThrow(SignerError)
    const secp = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'secp256k1', "m/44'/60'/0'/0/0")
    await expect(new WalletManagerNear(secp).getAccount()).rejects.toThrow(/ed25519/)
    const f = fakeNode()
    const a = await new WalletManagerNear(hardwareWallet(true).signer, { provider: f.fetch }).getAccount()
    await expect(a.transfer({ recipient: 'alice.near', amount: 1n })).rejects.toBeInstanceOf(UserRejectedError)
    expect(f.sent).toHaveLength(0)
  })

  it('a derivable SeedSigner at m/44\'/397\' yields getAccount(i) children matching the seed path', async () => {
    const branch = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'ed25519', NEAR_BASE_PATH)
    const m = new WalletManagerNear(branch)
    const fromSeed = new WalletManagerNear(SEED)
    for (const i of [0, 1, 2]) expect((await m.getAccount(i)).address).toBe((await fromSeed.getAccount(i)).address)
    expect((await m.getAccount(1)).path).toBe(`${NEAR_BASE_PATH}/1'`)
    m.dispose(); fromSeed.dispose()
  })

  it('fromPrivateKey / withAccountId / dispose', async () => {
    const { privateKey, publicKey } = deriveEd25519(seedFromMnemonicSync(SEED), `${NEAR_BASE_PATH}/0'`)
    const a = WalletAccountNear.fromPrivateKey(privateKey, publicKey, `${NEAR_BASE_PATH}/0'`)
    expect(a.address).toBe(ACCOUNT0)
    expect(a.index).toBe(0)
    const named = a.withAccountId('alice.near')
    expect(named.address).toBe('alice.near')
    expect(named.publicKeyString).toBe(a.publicKeyString)
    expect(named.toReadOnlyAccount().chain).toBe('near:mainnet')
    a.dispose()
    expect(privateKey.every((b) => b === 0)).toBe(true)
    await expect(a.sign('x')).rejects.toThrow(/disposed/)
    expect(() => new WalletAccountNear(LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'secp256k1', "m/44'/60'/0'/0/0"), publicKey, 'x')).toThrow(/ed25519/)
  })
})
