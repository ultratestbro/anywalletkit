import { describe, expect, it } from 'vitest'
import { InsufficientFundsError } from '@forgewallet/core'
import * as ecc from '@bitcoinerlab/secp256k1'
import { Transaction, address as btcAddress, networks, payments, script as bscript } from 'bitcoinjs-lib'
import { WalletManagerBtc, recoverMessagePublicKey } from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' // BIP-84 test vector, account 0
const ADDR1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g' // account 1
const RECIPIENT = ADDR1
const TXID_A = '1'.repeat(64)
const TXID_B = '2'.repeat(64)
const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

/** Fake Blockbook: routes by URL path, records broadcasts. */
function fakeBlockbook(opts: { utxos?: Array<{ txid: string; vout: number; value: string; height: number }>; feeBtcPerKb?: string; txInfo?: Record<string, unknown> | null; fail?: boolean } = {}) {
  const sent: string[] = []
  const calls: string[] = []
  const utxos = opts.utxos ?? [
    { txid: TXID_A, vout: 0, value: '100000', height: 800000 },
    { txid: TXID_B, vout: 1, value: '50000', height: 800001 },
  ]
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    calls.push(path)
    if (opts.fail) throw new Error('connection refused')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (path.startsWith('/api/v2/utxo/')) return json(utxos)
    if (path.startsWith('/api/v1/estimatefee/')) return json({ result: opts.feeBtcPerKb ?? '0.00010000' }) // 10 sat/vB
    if (path.startsWith('/api/v2/address/')) return json({ balance: '150000', unconfirmedBalance: '0', transactions: [] })
    if (path.startsWith('/api/v2/sendtx/')) { sent.push(path.slice('/api/v2/sendtx/'.length)); return json({ result: Transaction.fromHex(sent.at(-1)!).getId() }) }
    if (path.startsWith('/api/v2/tx/')) return opts.txInfo === null ? json({ error: 'not found' }, 404) : json(opts.txInfo ?? { txid: path.slice(11), blockHeight: 800010, confirmations: 3, fees: '1410', hex: '00' })
    return json({ error: `unmocked ${path}` }, 500)
  }) as typeof fetch
  return { fetchFn, sent, calls, utxos }
}

const mk = (fetchFn: typeof fetch, extra: Record<string, unknown> = {}) =>
  new WalletManagerBtc(SEED, { network: 'bitcoin', client: { type: 'blockbook-http', clientConfig: { url: 'https://bb.example' } }, fetch: fetchFn, ...extra })

describe('WalletAccountBtc', () => {
  it('derives the BIP-84 test vector, accepts relative paths, and exposes chain id', async () => {
    const m = new WalletManagerBtc(SEED, { network: 'bitcoin' })
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(ADDR0)
    expect(a.index).toBe(0)
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
    expect(hex(recoverMessagePublicKey('hello', sig)!.publicKey)).toBe(hex(a.publicKey))
    m.dispose()
  })

  it('transfer selects UTXOs, builds a valid signed segwit tx with change, pays feeRate × vsize', async () => {
    const f = fakeBlockbook()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    const res = await a.transfer({ recipient: RECIPIENT, amount: 60_000n })
    expect(f.sent).toHaveLength(1)
    const tx = Transaction.fromHex(f.sent[0]!)
    expect(res.hash).toBe(tx.getId())
    // inputs reference the fake UTXOs
    const spent = tx.ins.map((i) => `${hex(Uint8Array.from(i.hash).reverse())}:${i.index}`)
    for (const s of spent) expect(f.utxos.map((u) => `${u.txid}:${u.vout}`)).toContain(s)
    // outputs: recipient + change back to us
    const outs = tx.outs.map((o) => ({ addr: btcAddress.fromOutputScript(o.script, networks.bitcoin), value: BigInt(o.value) }))
    expect(outs.find((o) => o.addr === RECIPIENT)?.value).toBe(60_000n)
    const change = outs.find((o) => o.addr === ADDR0)
    expect(change && change.value > 0n).toBe(true)
    // fee = inputs − outputs ≈ 10 sat/vB × vsize (coinselect estimate ≥ real size)
    const inputTotal = spent.reduce((s, key) => s + BigInt(f.utxos.find((u) => `${u.txid}:${u.vout}` === key)!.value), 0n)
    const fee = inputTotal - outs.reduce((s, o) => s + o.value, 0n)
    expect(fee).toBe(res.fee)
    const vsize = BigInt(tx.virtualSize())
    expect(fee).toBeGreaterThanOrEqual(vsize * 10n)
    expect(fee).toBeLessThanOrEqual(vsize * 10n + 50n)
    // every input carries a valid p2wpkh witness signature from our key
    tx.ins.forEach((inp, i) => {
      expect(inp.witness).toHaveLength(2)
      const [sig, pub] = inp.witness as [Uint8Array, Uint8Array]
      expect(hex(pub)).toBe(hex(a.publicKey))
      const prevout = f.utxos.find((u) => `${u.txid}:${u.vout}` === spent[i])!
      const scriptCode = payments.p2pkh({ hash: payments.p2wpkh({ pubkey: pub }).hash! }).output!
      const h = tx.hashForWitnessV0(i, scriptCode, BigInt(prevout.value), Transaction.SIGHASH_ALL)
      const der = bscript.signature.decode(sig)
      expect(der.hashType).toBe(Transaction.SIGHASH_ALL)
      expect(ecc.verify(h, pub, der.signature)).toBe(true)
    })
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
    const tx = Transaction.fromHex(f.sent[0]!)
    expect(res.fee).toBeLessThan(BigInt(tx.virtualSize()) * 10n)
    expect(f.calls.some((c) => c.startsWith('/api/v1/estimatefee'))).toBe(false)
    m.dispose()
  })

  it('signTransaction returns hex that sendTransaction re-broadcasts without re-signing', async () => {
    const f = fakeBlockbook({ txInfo: { txid: TXID_A, blockHeight: 800000, confirmations: 10, hex: new Transaction().toHex() } })
    // getTransaction for prev inputs needs real hex with matching outputs; build it
    const prevA = new Transaction(); prevA.addInput(new Uint8Array(32), 0); prevA.addOutput(btcAddress.toOutputScript(ADDR0, networks.bitcoin), 100_000n)
    const prevB = new Transaction(); prevB.addInput(new Uint8Array(32), 0); prevB.addOutput(new Uint8Array([0x6a]), 1n); prevB.addOutput(btcAddress.toOutputScript(ADDR0, networks.bitcoin), 50_000n)
    const utxos = [{ txid: prevA.getId(), vout: 0, value: '100000', height: 1 }, { txid: prevB.getId(), vout: 1, value: '50000', height: 1 }]
    const base = fakeBlockbook({ utxos })
    const fetchFn = (async (input: string | URL | Request) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '')
      if (path.startsWith('/api/v2/tx/')) {
        const id = path.slice(11)
        const tx = id === prevA.getId() ? prevA : prevB
        return new Response(JSON.stringify({ txid: id, blockHeight: 1, confirmations: 9, hex: tx.toHex() }), { status: 200 })
      }
      return base.fetchFn(input)
    }) as typeof fetch
    const m = mk(fetchFn)
    const a = await m.getAccount(0)
    const signed = await a.signTransaction({ to: RECIPIENT, value: 60_000n })
    expect(base.sent).toHaveLength(0)
    const res = await a.sendTransaction(signed)
    expect(base.sent[0]).toBe(signed)
    expect(res.hash).toBe(Transaction.fromHex(signed).getId())
    expect(res.fee).toBe((await a.quoteSendTransaction(signed)).fee)
    void f
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

  it('insufficient funds throws InsufficientFundsError; dust amounts and tokens are rejected', async () => {
    const f = fakeBlockbook()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 10_000_000n })).rejects.toBeInstanceOf(InsufficientFundsError)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 100n })).rejects.toThrow(/dust/)
    await expect(a.transfer({ token: 'x', recipient: RECIPIENT, amount: 1000n })).rejects.toThrow(/not supported/)
    expect(f.sent).toHaveLength(0)
    const empty = fakeBlockbook({ utxos: [] })
    await expect((await mk(empty.fetchFn).getAccount(0)).transfer({ recipient: RECIPIENT, amount: 1000n })).rejects.toBeInstanceOf(InsufficientFundsError)
    m.dispose()
  })

  it('dust change is folded into the fee (single output)', async () => {
    const f = fakeBlockbook({ utxos: [{ txid: TXID_A, vout: 0, value: '61350', height: 1 }] /* change ≈ 250 sats < 294 dust → folded */ })
    const m = mk(f.fetchFn)
    await (await m.getAccount(0)).transfer({ recipient: RECIPIENT, amount: 60_000n })
    const tx = Transaction.fromHex(f.sent[0]!)
    expect(tx.outs).toHaveLength(1)
    expect(BigInt(tx.outs[0]!.value)).toBe(60_000n)
    m.dispose()
  })

  it('getBalance, getTransactionReceipt (mined / unconfirmed / unknown), getFeeRates', async () => {
    const f = fakeBlockbook()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    expect(await a.getBalance()).toBe(150_000n)
    const r = await a.getTransactionReceipt(TXID_A)
    expect(r).toMatchObject({ hash: TXID_A, status: 1, blockNumber: 800010n, confirmations: 3, fee: 1410n })
    expect(await (await mk(fakeBlockbook({ txInfo: { txid: TXID_A, blockHeight: -1, confirmations: 0 } }).fetchFn).getAccount(0)).getTransactionReceipt(TXID_A)).toBeUndefined()
    expect(await (await mk(fakeBlockbook({ txInfo: null }).fetchFn).getAccount(0)).getTransactionReceipt(TXID_A)).toBeUndefined()
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
    ], fetch: (async (input: string | URL | Request) => (String(input).includes('dead.example') ? dead.fetchFn(input) : alive.fetchFn(input))) as typeof fetch })
    expect(await (await m.getAccount(0)).getBalance()).toBe(150_000n)
    expect(dead.calls).toHaveLength(1)
    expect(alive.calls).toHaveLength(1)
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
  })

  it('electrum-ws is reserved and says so', () => {
    expect(() => new WalletManagerBtc(SEED, { client: { type: 'electrum-ws', clientConfig: { url: 'wss://x' } } }).getReadOnlyAccount(ADDR0)).toThrow(/electrum-ws/)
  })
})
