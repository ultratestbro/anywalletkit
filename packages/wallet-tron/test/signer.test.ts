import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { LocalSigner, SignerError, UserRejectedError, deriveSecp256k1, externalSigner, seedFromMnemonicSync } from '@anywalletkit/core'
import { encodeRawData, TRON_ACCOUNT_BRANCH, WalletAccountTron, WalletManagerTron, addressFromPublicKey, recoverMessageAddress, type TronFetch, type TronRawTransaction } from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH' // conformance vector, account 0
const EXISTING = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9'
const NOW = 1_800_000_000_000

const withNow = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const real = Date.now
  Date.now = () => NOW
  try { return await fn() } finally { Date.now = real }
}

/** Minimal fake node: TRX transfer build + resources + params + broadcast capture. */
function fakeNode() {
  const broadcast: TronRawTransaction[] = []
  const handlers: Record<string, (b: Record<string, unknown>) => unknown> = {
    '/wallet/createtransaction': (b) => {
      const raw_data: TronRawTransaction['raw_data'] = { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: b.owner_address, to_address: b.to_address, amount: b.amount }, type_url: 'type.googleapis.com/protocol.TransferContract' } }], ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW }
      const raw_data_hex = Buffer.from(encodeRawData(raw_data)).toString('hex')
      return { txID: Buffer.from(sha256(hexToBytes(raw_data_hex))).toString('hex'), raw_data_hex, visible: false, raw_data }
    },
    '/wallet/getaccount': (b) => ({ address: b.address, balance: 5_000_000 }),
    '/wallet/getaccountresource': () => ({ freeNetLimit: 600, freeNetUsed: 0 }),
    '/wallet/getchainparameters': () => ({ chainParameter: [{ key: 'getTransactionFee', value: 1000 }, { key: 'getEnergyFee', value: 210 }] }),
    '/wallet/broadcasttransaction': (b) => { broadcast.push(b as unknown as TronRawTransaction); return { result: true, txid: b.txID } },
  }
  const fetch: TronFetch = async (path, body) => { const h = handlers[path]; if (!h) throw new Error(`unmocked ${path}`); return h(body as Record<string, unknown>) }
  return { fetch, broadcast }
}

/** A "hardware wallet" holding the account-0 key outside the SDK. */
function hardwareWallet(reject = false) {
  const { privateKey, publicKey } = deriveSecp256k1(seedFromMnemonicSync(SEED), `${TRON_ACCOUNT_BRANCH}/0`)
  const contexts: string[] = []
  const signer = externalSigner({
    curve: 'secp256k1',
    publicKey,
    sign: async (payload, o) => {
      contexts.push(o.context ?? '')
      if (reject) throw new UserRejectedError()
      const r = secp256k1.sign(payload, privateKey, { prehash: false, format: 'recovered' })
      const out = new Uint8Array(65); out.set(r.subarray(1)); out[64] = r[0]!
      return out
    },
  })
  return { signer, contexts, publicKey }
}

/** Recover the signer's Tron address from a broadcast transaction's signature over txID. */
function recoverTxAddress(tx: TronRawTransaction): string {
  const sig = hexToBytes(tx.signature![0]!)
  const pub = secp256k1.recoverPublicKey(Uint8Array.from([sig[64]!, ...sig.subarray(0, 64)]), hexToBytes(tx.txID), { prehash: false })
  return addressFromPublicKey(pub)
}

describe('WalletManagerTron with an external signer', () => {
  it('builds the account at the signer key; a TRX transfer and a TIP-191 message are signed through it', async () => {
    const f = fakeNode()
    const { signer, contexts } = hardwareWallet()
    const m = new WalletManagerTron(signer, { provider: f.fetch })
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(ADDR0)
    expect(a.path).toBe('external')
    expect(a.signer).toBe(signer)
    expect(await m.getAccount()).toBe(a)

    const res = await withNow(() => a.transfer({ recipient: EXISTING, amount: 1_000_000n }))
    expect(f.broadcast).toHaveLength(1)
    expect(res.hash).toBe(f.broadcast[0]!.txID)
    expect(recoverTxAddress(f.broadcast[0]!)).toBe(ADDR0)

    const sig = await a.sign('hello')
    expect(recoverMessageAddress('hello', sig)).toBe(ADDR0)
    expect(contexts).toEqual(['tron-tx', 'tron-message'])
    m.dispose()
  })

  it('refuses other indexes/paths, the wrong curve, and surfaces UserRejectedError', async () => {
    const m = new WalletManagerTron(hardwareWallet().signer)
    await expect(m.getAccount(1)).rejects.toThrow(/one account/)
    await expect(m.getAccountByPath("0'/0/3")).rejects.toThrow(SignerError)
    const ed = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'ed25519', "m/44'/501'/0'/0'")
    await expect(new WalletManagerTron(ed).getAccount()).rejects.toThrow(/secp256k1/)
    const f = fakeNode()
    const a = await new WalletManagerTron(hardwareWallet(true).signer, { provider: f.fetch }).getAccount()
    await expect(withNow(() => a.transfer({ recipient: EXISTING, amount: 1n }))).rejects.toBeInstanceOf(UserRejectedError)
    expect(f.broadcast).toHaveLength(0)
  })

  it('a derivable SeedSigner at the account branch yields getAccount(i) children matching the seed path', async () => {
    const branch = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'secp256k1', TRON_ACCOUNT_BRANCH)
    const m = new WalletManagerTron(branch)
    const fromSeed = new WalletManagerTron(SEED)
    for (const i of [0, 1, 2]) {
      expect(await (await m.getAccount(i)).getAddress()).toBe(await (await fromSeed.getAccount(i)).getAddress())
    }
    expect((await m.getAccount(1)).path).toBe(`${TRON_ACCOUNT_BRANCH}/1`)
    m.dispose(); fromSeed.dispose()
  })

  it('fromPrivateKey keeps the raw-key constructor shape; dispose zeroizes and blocks signing', async () => {
    const { privateKey, publicKey } = deriveSecp256k1(seedFromMnemonicSync(SEED), `${TRON_ACCOUNT_BRANCH}/0`)
    const a = WalletAccountTron.fromPrivateKey(privateKey, publicKey, `${TRON_ACCOUNT_BRANCH}/0`)
    expect(await a.getAddress()).toBe(ADDR0)
    expect(a.index).toBe(0)
    expect(recoverMessageAddress('x', await a.sign('x'))).toBe(ADDR0)
    a.dispose()
    expect(privateKey.every((b) => b === 0)).toBe(true)
    await expect(a.sign('x')).rejects.toThrow(/disposed/)
    expect(() => new WalletAccountTron(LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'ed25519', "m/44'/501'/0'"), publicKey, 'x')).toThrow(/secp256k1/)
  })
})
