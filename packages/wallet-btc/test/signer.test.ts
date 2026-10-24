import { describe, expect, it } from 'vitest'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { SigHash, p2pkh } from '@scure/btc-signer'
import { LocalSigner, SignerError, UserRejectedError, deriveSecp256k1, externalSigner, seedFromMnemonicSync, tweakSecp256k1PrivateKey, type SignOptions, type SignScheme } from '@anywalletkit/core'
import { WalletAccountBtc, WalletManagerBtc, decodeAddress, networkParams, parseRawTransaction, recoverMessagePublicKey } from '../src/index.js'
import { ADDR0, ADDR1, SEED, fakeBlockbook, hex } from './helpers.js'

const BIP86_0 = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr' // BIP-86 vector, account 0 external 0
const CLIENT = { network: 'bitcoin' as const, client: { type: 'blockbook-http' as const, clientConfig: { url: 'https://bb.example' } } }
const seedBytes = seedFromMnemonicSync(SEED)

/**
 * A "hardware wallet" holding the key outside the SDK. Signs whatever scheme it
 * was allowed; honours `tweak` for schnorr the way a BIP-86-aware device does.
 */
function hardwareWallet(path: string, schemes: SignScheme[], reject = false) {
  const { privateKey, publicKey } = deriveSecp256k1(seedBytes, path)
  const calls: Array<{ scheme: SignScheme; context: string | undefined; tweak: boolean }> = []
  const signer = externalSigner({
    curve: 'secp256k1',
    publicKey,
    schemes,
    sign: async (payload, o: SignOptions & { scheme: SignScheme }) => {
      calls.push({ scheme: o.scheme, context: o.context, tweak: o.tweak !== undefined })
      if (reject) throw new UserRejectedError()
      switch (o.scheme) {
        case 'ecdsa': return secp256k1.sign(payload, privateKey, { prehash: false, format: 'compact', lowS: true })
        case 'ecdsa-recoverable': {
          const r = secp256k1.sign(payload, privateKey, { prehash: false, format: 'recovered' })
          const out = new Uint8Array(65); out.set(r.subarray(1)); out[64] = r[0]!
          return out
        }
        case 'schnorr': return schnorr.sign(payload, o.tweak ? tweakSecp256k1PrivateKey(privateKey, o.tweak) : privateKey)
        default: throw new Error('unexpected scheme')
      }
    },
  })
  return { signer, calls, publicKey }
}

describe('WalletManagerBtc with an external signer', () => {
  it('p2wpkh: the signer sees ecdsa sighashes; the witness verifies under its key', async () => {
    const f = fakeBlockbook()
    const { signer, calls, publicKey } = hardwareWallet("m/84'/0'/0'/0/0", ['ecdsa', 'ecdsa-recoverable'])
    const m = new WalletManagerBtc(signer, { ...CLIENT, fetch: f.fetchFn })
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(ADDR0)
    expect(a.path).toBe('external')
    expect(a.signer).toBe(signer)
    expect(await m.getAccount()).toBe(a)

    const res = await a.transfer({ recipient: ADDR1, amount: 60_000n })
    const tx = parseRawTransaction(f.sent[0]!)
    expect(res.hash).toBe(tx.id)
    expect(tx.inputsLength).toBeGreaterThan(0)
    for (let i = 0; i < tx.inputsLength; i++) {
      const [sig, pub] = tx.getInput(i).finalScriptWitness as [Uint8Array, Uint8Array]
      expect(hex(pub)).toBe(hex(publicKey))
      expect(sig.at(-1)).toBe(SigHash.ALL)
      const inp = tx.getInput(i)
      const prevout = f.utxos.find((u) => u.txid === hex(inp.txid!) && u.vout === inp.index)!
      const h = tx.preimageWitnessV0(i, p2pkh(pub).script, SigHash.ALL, BigInt(prevout.value))
      expect(secp256k1.verify(sig.subarray(0, -1), h, pub, { prehash: false, format: 'der' })).toBe(true)
    }
    expect(calls.every((c) => c.scheme === 'ecdsa' && c.context === 'btc-sighash' && !c.tweak)).toBe(true)
    expect(calls).toHaveLength(tx.inputsLength)

    // BIP-137 goes through the same signer, recoverable
    const sig = await a.sign('hello')
    expect(hex(recoverMessagePublicKey('hello', sig)!.publicKey)).toBe(hex(publicKey))
    expect(await a.verify('hello', sig)).toBe(true)
    expect(calls.at(-1)).toEqual({ scheme: 'ecdsa-recoverable', context: 'btc-message', tweak: false })
    m.dispose()
  })

  it('p2tr: schnorr + BIP-341 tweak; the key-path signature verifies under the output key of the BIP-86 vector', async () => {
    const f = fakeBlockbook()
    const { signer, calls } = hardwareWallet("m/86'/0'/0'/0/0", ['ecdsa', 'ecdsa-recoverable', 'schnorr'])
    const m = new WalletManagerBtc(signer, { ...CLIENT, addressType: 'p2tr', fetch: f.fetchFn })
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(BIP86_0)
    expect(a.addressType).toBe('p2tr')

    await a.transfer({ recipient: ADDR1, amount: 60_000n })
    const tx = parseRawTransaction(f.sent[0]!)
    const program = decodeAddress(BIP86_0, networkParams('bitcoin')).script.subarray(2) // OP_1 PUSH32 <xonly>
    const scripts = Array.from({ length: tx.inputsLength }, () => decodeAddress(BIP86_0, networkParams('bitcoin')).script)
    const amounts = Array.from({ length: tx.inputsLength }, (_, i) => {
      const inp = tx.getInput(i)
      return BigInt(f.utxos.find((u) => u.txid === hex(inp.txid!) && u.vout === inp.index)!.value)
    })
    for (let i = 0; i < tx.inputsLength; i++) {
      const w = tx.getInput(i).finalScriptWitness as Uint8Array[]
      expect(w).toHaveLength(1)
      expect(w[0]).toHaveLength(64) // SIGHASH_DEFAULT → no trailing byte
      const h = tx.preimageWitnessV1(i, scripts, SigHash.DEFAULT, amounts)
      expect(schnorr.verify(w[0]!, h, program)).toBe(true)
    }
    expect(calls.every((c) => c.scheme === 'schnorr' && c.context === 'btc-taproot-keypath' && c.tweak)).toBe(true)
    await expect(a.sign('x')).rejects.toThrow(/taproot/)
    m.dispose()
  })

  it('a signer without schnorr cannot back a p2tr account; without ecdsa, not a p2wpkh one', async () => {
    const onlyRecoverable = hardwareWallet("m/86'/0'/0'/0/0", ['ecdsa-recoverable']).signer
    await expect(new WalletManagerBtc(onlyRecoverable, { addressType: 'p2tr' }).getAccount()).rejects.toThrow(SignerError)
    await expect(new WalletManagerBtc(onlyRecoverable, { addressType: 'p2tr' }).getAccount()).rejects.toThrow(/schnorr/)
    const onlySchnorr = hardwareWallet("m/84'/0'/0'/0/0", ['schnorr']).signer
    await expect(new WalletManagerBtc(onlySchnorr).getAccount()).rejects.toThrow(/ecdsa/)
  })

  it('refuses other indexes/paths, the wrong curve, and surfaces UserRejectedError', async () => {
    const m = new WalletManagerBtc(hardwareWallet("m/84'/0'/0'/0/0", ['ecdsa', 'ecdsa-recoverable']).signer)
    await expect(m.getAccount(1)).rejects.toThrow(/one account/)
    await expect(m.getAccountByPath("0'/0/3")).rejects.toThrow(SignerError)
    const ed = LocalSigner.fromSeed(seedBytes, 'ed25519', "m/44'/501'/0'/0'")
    await expect(new WalletManagerBtc(ed).getAccount()).rejects.toThrow(/secp256k1/)
    const f = fakeBlockbook()
    const rejecting = hardwareWallet("m/84'/0'/0'/0/0", ['ecdsa', 'ecdsa-recoverable'], true).signer
    const a = await new WalletManagerBtc(rejecting, { ...CLIENT, fetch: f.fetchFn }).getAccount()
    await expect(a.transfer({ recipient: ADDR1, amount: 1_000n })).rejects.toBeInstanceOf(UserRejectedError)
    expect(f.sent).toHaveLength(0)
  })

  it('a derivable SeedSigner at the account branch yields the same children as the seed manager (p2wpkh and p2tr)', async () => {
    for (const addressType of ['p2wpkh', 'p2tr'] as const) {
      const bySeed = new WalletManagerBtc(SEED, { addressType })
      const root = LocalSigner.fromSeed(seedBytes, 'secp256k1', `${bySeed.basePath}/0'/0`)
      const bySigner = new WalletManagerBtc(root, { addressType })
      for (const i of [0, 1, 5]) expect(await (await bySigner.getAccount(i)).getAddress()).toBe(await (await bySeed.getAccount(i)).getAddress())
      expect((await bySigner.getAccount(1)).path).toBe(`${bySeed.basePath}/0'/0/1`)
      await expect(bySigner.getAccountByPath("m/44'/0'/0'/0/0")).rejects.toThrow(/cannot provide/)
      bySeed.dispose(); bySigner.dispose()
    }
    const leaf = LocalSigner.fromSeed(seedBytes, 'secp256k1', "m/84'/0'/0'/0/0")
    const lm = new WalletManagerBtc(leaf)
    expect(await (await lm.getAccount(0)).getAddress()).toBe(ADDR0)
    await expect(lm.getAccount(2)).rejects.toThrow(/cannot provide/)
    lm.dispose()
  })

  it('fromPrivateKey keeps the raw-key constructor shape; dispose disposes the signer', async () => {
    const { privateKey, publicKey } = deriveSecp256k1(seedBytes, "m/84'/0'/0'/0/0")
    const a = WalletAccountBtc.fromPrivateKey(privateKey, publicKey, "m/84'/0'/0'/0/0", { network: 'bitcoin' })
    expect(await a.getAddress()).toBe(ADDR0)
    expect(a.signer.kind).toBe('seed')
    const sig = await a.sign('hello')
    expect(await a.verify('hello', sig)).toBe(true)
    a.dispose()
    await expect(a.sign('hello')).rejects.toThrow(/disposed/)
    await expect(a.signer.sign(new Uint8Array(32))).rejects.toThrow(/disposed/)
  })
})
