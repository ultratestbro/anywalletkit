import { describe, expect, it } from 'vitest'
import { InsufficientFundsError } from '@forgewallet/core'
import { p2pkh, p2tr, SigHash } from '@scure/btc-signer'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { FINAL_SEQUENCE, RBF_SEQUENCE, UnsupportedAddressTypeError, WalletManagerBtc, parseRawTransaction, recoverMessagePublicKey } from '../src/index.js'
import { ADDR0, ADDR1, SEED, TXID_A, fakeBlockbook, hex, mk, prevTx } from './helpers.js'

const RECIPIENT = ADDR1

describe('WalletAccountBtc (p2wpkh)', () => {
  it('derives the BIP-84 test vector, accepts relative paths, and exposes chain id', async () => {
    const m = new WalletManagerBtc(SEED, { network: 'bitcoin' })
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(ADDR0)
    expect(a.index).toBe(0)
    expect(a.addressType).toBe('p2wpkh')
    expect(a.chain).toBe('bip122:000000000019d6689c085ae165831e93')
    expect(await m.getAccountByPath("0'/0/0")).toBe(a)
    expect(await (await m.getAccount(1)).getAddress()).toBe(ADDR1)
    m.dispose()
  })

  it('testnet uses coin type 1 and tb1 addresses', async () => {
    const m = new WalletManagerBtc(SEED, { network: 'testnet' })
    const a = await m.getAccount(0)
    expect(a.path).toBe("m/84'/1'/0'/0/0")
    expect((await a.getAddress()).startsWith('tb1q')).toBe(true)
    expect(a.chain).toBe('bip122:000000000933ea01ad0ee984209779ba')
    m.dispose()
  })

  it('sign is BIP-137 p2wpkh (header 39 + recovery, base64) and verify agrees', async () => {
    const m = new WalletManagerBtc(SEED)
    const a = await m.getAccount(0)
    const sig = await a.sign('hello')
    const bytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0))
    expect(bytes).toHaveLength(65)
    expect([39, 40, 41, 42]).toContain(bytes[0])
    expect(await a.verify('hello', sig)).toBe(true)
    expect(await a.verify('hellp', sig)).toBe(false)
    expect(await a.verify('hello', 'not base64!!')).toBe(false)
    expect(hex(recoverMessagePublicKey('hello', sig)!.publicKey)).toBe(hex(a.publicKey))
    // (the Electrum/Core known-answer for this encoding is pinned by the conformance vectors)
    m.dispose()
  })

  it('transfer selects UTXOs, builds a valid signed segwit tx with change, pays feeRate × vsize', async () => {
    const f = fakeBlockbook()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    const res = await a.transfer({ recipient: RECIPIENT, amount: 60_000n })
    expect(f.sent).toHaveLength(1)
    const tx = parseRawTransaction(f.sent[0]!)
    expect(res.hash).toBe(tx.id)
    // inputs reference the fake UTXOs
    const spent = Array.from({ length: tx.inputsLength }, (_, i) => `${hex(tx.getInput(i).txid!)}:${tx.getInput(i).index}`)
    for (const s of spent) expect(f.utxos.map((u) => `${u.txid}:${u.vout}`)).toContain(s)
    // outputs: recipient + change back to us
    const outs = Array.from({ length: tx.outputsLength }, (_, i) => ({ addr: tx.getOutputAddress(i), value: tx.getOutput(i).amount! }))
    expect(outs.find((o) => o.addr === RECIPIENT)?.value).toBe(60_000n)
    const change = outs.find((o) => o.addr === ADDR0)
    expect(change && change.value > 0n).toBe(true)
    // fee = inputs − outputs = feeRate × estimated vsize (estimate assumes 72-byte sigs → ≥ real)
    const inputTotal = spent.reduce((s, key) => s + BigInt(f.utxos.find((u) => `${u.txid}:${u.vout}` === key)!.value), 0n)
    const fee = inputTotal - outs.reduce((s, o) => s + o.value, 0n)
    expect(fee).toBe(res.fee)
    const vsize = BigInt(tx.vsize)
    expect(fee).toBeGreaterThanOrEqual(vsize * 10n)
    expect(fee).toBeLessThanOrEqual(vsize * 10n + 50n)
    // every input carries a valid p2wpkh witness signature from our key (SIGHASH_ALL, DER)
    for (let i = 0; i < tx.inputsLength; i++) {
      const w = tx.getInput(i).finalScriptWitness!
      expect(w).toHaveLength(2)
      const [sig, pub] = w as [Uint8Array, Uint8Array]
      expect(hex(pub)).toBe(hex(a.publicKey))
      expect(sig.at(-1)).toBe(SigHash.ALL)
      const prevout = f.utxos.find((u) => `${u.txid}:${u.vout}` === spent[i])!
      const h = tx.preimageWitnessV0(i, p2pkh(pub).script, SigHash.ALL, BigInt(prevout.value))
      expect(secp256k1.verify(sig.subarray(0, -1), h, pub, { prehash: false, format: 'der' })).toBe(true)
    }
    // RBF on by default; locktime = tip height from the transport (anti-fee-sniping)
    expect(tx.getInput(0).sequence).toBe(RBF_SEQUENCE)
    expect(tx.lockTime).toBe(850_000)
    m.dispose()
  })

  it('rbf:false signals a final sequence; antiFeeSniping:false leaves locktime 0', async () => {
    const f = fakeBlockbook()
    const m = mk(f.fetchFn, { antiFeeSniping: false })
    await (await m.getAccount(0)).sendTransaction({ to: RECIPIENT, value: 60_000n, rbf: false })
    const tx = parseRawTransaction(f.sent[0]!)
    expect(tx.getInput(0).sequence).toBe(FINAL_SEQUENCE)
    expect(tx.lockTime).toBe(0)
    m.dispose()
  })

  it('quoteSendTransaction matches the fee the broadcast tx actually pays', async () => {
    const f = fakeBlockbook()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    const { fee } = await a.quoteSendTransaction({ to: RECIPIENT, value: 60_000n })
    const res = await a.sendTransaction({ to: RECIPIENT, value: 60_000n })
    expect(res.fee).toBe(fee)
    m.dispose()
  })

  it('explicit feeRate overrides the estimator', async () => {
    const f = fakeBlockbook()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    const res = await a.sendTransaction({ to: RECIPIENT, value: 60_000n, feeRate: 2n })
    const tx = parseRawTransaction(f.sent[0]!)
    expect(res.fee).toBeLessThan(BigInt(tx.vsize) * 10n)
    expect(f.calls.some((c) => c.startsWith('/api/v1/estimatefee'))).toBe(false)
    m.dispose()
  })

  it('signTransaction returns hex that sendTransaction re-broadcasts without re-signing', async () => {
    const prevA = prevTx([[ADDR0, 100_000n]])
    const prevB = prevTx([[ADDR1, 1n], [ADDR0, 50_000n]])
    const utxos = [{ txid: prevA.id, vout: 0, value: '100000', height: 1 }, { txid: prevB.id, vout: 1, value: '50000', height: 1 }]
    const f = fakeBlockbook({ utxos, prevTxs: [prevA, prevB] })
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    const signed = await a.signTransaction({ to: RECIPIENT, value: 60_000n })
    expect(f.sent).toHaveLength(0)
    const res = await a.sendTransaction(signed)
    expect(f.sent[0]).toBe(signed)
    expect(res.hash).toBe(parseRawTransaction(signed).id)
    expect(res.fee).toBe((await a.quoteSendTransaction(signed)).fee)
    const desc = await a.describeTransaction(signed)
    expect(desc.txid).toBe(res.hash)
    expect(desc.outputs.map((o) => o.role).sort()).toEqual(['change', 'recipient'])
    m.dispose()
  })

  it('transferMaxFee / transactionMaxFee stop before broadcast', async () => {
    const f = fakeBlockbook()
    const m = mk(f.fetchFn, { transferMaxFee: 1n, transactionMaxFee: 1n })
    const a = await m.getAccount(0)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 60_000n })).rejects.toThrow(/maximum fee/)
    await expect(a.sendTransaction({ to: RECIPIENT, value: 60_000n })).rejects.toThrow(/maximum fee/)
    expect(f.sent).toHaveLength(0)
    m.dispose()
  })

  it('insufficient funds throws InsufficientFundsError; dust amounts, bad addresses and tokens are rejected', async () => {
    const f = fakeBlockbook()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 10_000_000n })).rejects.toBeInstanceOf(InsufficientFundsError)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 100n })).rejects.toThrow(/dust/)
    await expect(a.transfer({ recipient: 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl', amount: 1000n })).rejects.toThrow(/Invalid bitcoin address/)
    await expect(a.transfer({ token: 'x', recipient: RECIPIENT, amount: 1000n })).rejects.toThrow(/not supported/)
    expect(f.sent).toHaveLength(0)
    const empty = fakeBlockbook({ utxos: [] })
    await expect((await mk(empty.fetchFn).getAccount(0)).transfer({ recipient: RECIPIENT, amount: 1000n })).rejects.toBeInstanceOf(InsufficientFundsError)
    m.dispose()
  })

  it('dust change is folded into the fee (single output) and reported as no-change', async () => {
    const dust = prevTx([[ADDR0, 61350n]], 3)
    const f = fakeBlockbook({ utxos: [{ txid: dust.id, vout: 0, value: '61350', height: 1 }], prevTxs: [dust] /* change ≈ 250 sats < 294 dust → folded */ })
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    const desc = await a.describeTransaction({ to: RECIPIENT, value: 60_000n })
    expect(desc.warnings).toContain('no-change')
    await a.transfer({ recipient: RECIPIENT, amount: 60_000n })
    const tx = parseRawTransaction(f.sent[0]!)
    expect(tx.outputsLength).toBe(1)
    expect(tx.getOutput(0).amount).toBe(60_000n)
    m.dispose()
  })

  it('describeTransaction names inputs, outputs, fee rate and warnings before anything is broadcast', async () => {
    const f = fakeBlockbook()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    const desc = await a.describeTransaction({ to: RECIPIENT, value: 5_000n })
    expect(f.sent).toHaveLength(0)
    expect(desc.kind).toBe('btc-transfer')
    expect(desc.amount).toBe(5_000n)
    expect(desc.inputs.length).toBeGreaterThan(0)
    expect(desc.outputs.find((o) => o.role === 'recipient')).toMatchObject({ address: RECIPIENT, value: 5_000n })
    expect(desc.outputs.find((o) => o.role === 'change')?.address).toBe(ADDR0)
    expect(desc.feeRate).toBeGreaterThanOrEqual(10)
    expect(desc.feeRate).toBeLessThan(11)
    expect(desc.rbf).toBe(true)
    expect(desc.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(desc.warnings).toContain('fee-over-10pct-of-amount') // ~1.4k fee on 5k
    m.dispose()
  })

  it('getMaxSpendable sweeps every input into one output and leaves no change', async () => {
    const f = fakeBlockbook()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    const max = await a.getMaxSpendable()
    expect(max.inputs).toBe(2)
    expect(max.changeValue).toBe(0n)
    expect(max.amount + max.fee).toBe(150_000n)
    const res = await a.sendTransaction({ to: RECIPIENT, value: max.amount })
    const tx = parseRawTransaction(f.sent[0]!)
    expect(tx.outputsLength).toBe(1)
    expect(res.fee).toBe(max.fee)
    expect(await (await mk(fakeBlockbook({ utxos: [] }).fetchFn).getAccount(0)).getMaxSpendable()).toMatchObject({ amount: 0n, fee: 0n, inputs: 0 })
    m.dispose()
  })

  it('getBalance, getTransactionReceipt (mined / unconfirmed / unknown), getFeeRates', async () => {
    const RECEIPT_TXID = '1'.repeat(64) // a tx the wallet only reads a receipt for (no prevout routing)
    const f = fakeBlockbook()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    expect(await a.getBalance()).toBe(150_000n)
    const r = await a.getTransactionReceipt(RECEIPT_TXID)
    expect(r).toMatchObject({ hash: RECEIPT_TXID, status: 1, blockNumber: 800010n, confirmations: 3, fee: 1410n })
    expect(await (await mk(fakeBlockbook({ txInfo: { txid: RECEIPT_TXID, blockHeight: -1, confirmations: 0 } }).fetchFn).getAccount(0)).getTransactionReceipt(RECEIPT_TXID)).toBeUndefined()
    expect(await (await mk(fakeBlockbook({ txInfo: null }).fetchFn).getAccount(0)).getTransactionReceipt(RECEIPT_TXID)).toBeUndefined()
    await expect(a.getTransactionReceipt('nope')).rejects.toThrow(/valid transaction hash/)
    expect(await m.getFeeRates()).toEqual({ slow: 10n, normal: 10n, fast: 10n })
    m.dispose()
  })

  it('failover walks the client list', async () => {
    const dead = fakeBlockbook({ fail: true })
    const alive = fakeBlockbook()
    const m = new WalletManagerBtc(SEED, { network: 'bitcoin', client: [
      { type: 'blockbook-http', clientConfig: { url: 'https://dead.example' } },
      { type: 'blockbook-http', clientConfig: { url: 'https://alive.example' } },
    ], fetch: (async (input: string | URL | Request, init?: RequestInit) => (String(input).includes('dead.example') ? dead.fetchFn(input, init) : alive.fetchFn(input, init))) as typeof fetch })
    expect(await (await m.getAccount(0)).getBalance()).toBe(150_000n)
    expect(dead.calls).toHaveLength(1)
    expect(alive.calls).toHaveLength(1)
    m.dispose()
  })

  it('malformed transport responses surface as NetworkError, not as a wrong balance', async () => {
    const f = fakeBlockbook({ override: (path) => (path.startsWith('/api/v2/utxo/') ? [{ txid: 'x' }] : undefined) })
    const m = mk(f.fetchFn)
    await expect((await m.getAccount(0)).transfer({ recipient: RECIPIENT, amount: 1000n })).rejects.toThrow(/unexpected shape/)
    m.dispose()
  })

  it('offline wallet refuses network ops with a clear error; read-only cannot sign; dispose kills signing', async () => {
    const m = new WalletManagerBtc(SEED)
    const a = await m.getAccount(0)
    await expect(a.getBalance()).rejects.toThrow(/client/)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1000n })).rejects.toThrow(/client/)
    const ro = a.toReadOnlyAccount() as unknown as Record<string, unknown>
    expect(ro.sign).toBeUndefined()
    expect(ro.sendTransaction).toBeUndefined()
    expect(await a.toReadOnlyAccount().getAddress()).toBe(ADDR0)
    m.dispose()
    await expect(a.sign('x')).rejects.toThrow(/disposed/)
    await expect(a.signTransaction({ to: RECIPIENT, value: 1000n })).rejects.toThrow(/disposed/)
  })

  it('a watch-only account on a script type we cannot spend from quotes with a clear error', async () => {
    const m = mk(fakeBlockbook().fetchFn)
    const ro = m.getReadOnlyAccount('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2') // p2pkh
    expect(ro.addressType).toBeUndefined()
    await expect(ro.quoteSendTransaction({ to: RECIPIENT, value: 1000n })).rejects.toBeInstanceOf(UnsupportedAddressTypeError)
    m.dispose()
  })
})

describe('WalletAccountBtc (p2tr, BIP-86)', () => {
  // Official BIP-86 test vectors for the 'abandon … about' mnemonic.
  const TR0 = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'
  const TR1 = 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh'
  const TR_CHANGE0 = 'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7'

  it('derives the BIP-86 vectors at m/86\'/0\'/0\'/{0,1}/i', async () => {
    const m = new WalletManagerBtc(SEED, { addressType: 'p2tr' })
    const a0 = await m.getAccount(0)
    expect(a0.path).toBe("m/86'/0'/0'/0/0")
    expect(a0.index).toBe(0)
    expect(a0.addressType).toBe('p2tr')
    expect(await a0.getAddress()).toBe(TR0)
    expect(await (await m.getAccount(1)).getAddress()).toBe(TR1)
    expect(await (await m.getAccountByPath("0'/1/0")).getAddress()).toBe(TR_CHANGE0)
    m.dispose()
  })

  it('BIP-137 message signing is refused with a clear error (BIP-322 not implemented)', async () => {
    const m = new WalletManagerBtc(SEED, { addressType: 'p2tr' })
    const a = await m.getAccount(0)
    await expect(a.sign('hello')).rejects.toBeInstanceOf(UnsupportedAddressTypeError)
    await expect(a.verify('hello', 'AAAA')).rejects.toBeInstanceOf(UnsupportedAddressTypeError)
    m.dispose()
  })

  it('transfer builds a key-path taproot spend with valid Schnorr signatures and change to our p2tr address', async () => {
    const f = fakeBlockbook({ utxos: [{ txid: TXID_A, vout: 0, value: '100000', height: 1 }, { txid: TXID_A, vout: 1, value: '50000', height: 1 }] })
    const m = mk(f.fetchFn, { addressType: 'p2tr' })
    const a = await m.getAccount(0)
    const quote = await a.quoteSendTransaction({ to: TR1, value: 120_000n })
    const res = await a.transfer({ recipient: TR1, amount: 120_000n })
    expect(res.fee).toBe(quote.fee)
    const tx = parseRawTransaction(f.sent[0]!)
    expect(tx.inputsLength).toBe(2)
    const outs = Array.from({ length: tx.outputsLength }, (_, i) => ({ addr: tx.getOutputAddress(i), value: tx.getOutput(i).amount! }))
    expect(outs.find((o) => o.addr === TR1)?.value).toBe(120_000n)
    expect(outs.find((o) => o.addr === TR0)!.value).toBe(150_000n - 120_000n - res.fee)
    // p2tr key-path: one 64-byte Schnorr sig (SIGHASH_DEFAULT) per input, valid for the tweaked key
    const tweaked = p2tr(a.publicKey.subarray(1)).tweakedPubkey
    const prevScripts = [a.scriptPubKey, a.scriptPubKey]
    const amounts = [100_000n, 50_000n]
    for (let i = 0; i < 2; i++) {
      const w = tx.getInput(i).finalScriptWitness!
      expect(w).toHaveLength(1)
      expect(w[0]).toHaveLength(64)
      const h = tx.preimageWitnessV1(i, prevScripts, SigHash.DEFAULT, amounts)
      expect(schnorr.verify(w[0]!, h, tweaked)).toBe(true)
    }
    // 2-in 2-out taproot ≈ 10.5 + 2×57.5 + 2×43 = 211.5 vB
    expect(tx.vsize).toBeLessThanOrEqual(212)
    expect(res.fee).toBe(BigInt(Math.ceil(10.5 + 2 * 57.5 + 2 * 43)) * 10n)
    m.dispose()
  })
})
