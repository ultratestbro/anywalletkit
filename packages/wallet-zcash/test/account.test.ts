import { describe, expect, it } from 'vitest'
import { InsufficientFundsError, NetworkError } from '@forgewallet/core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { mnemonicToAccount } from 'viem/accounts'
import { UnsafeTransactionError, WalletManagerZcash, decodeAddress, parseP2pkhScriptSig, parseTx, recoverMessagePublicKey, sighashAll, txid } from '../src/index.js'
import { SEED, TXID_A, TXID_B, fakeBlockchair, hex, mk } from './helpers.js'

const RECIPIENT = 't1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua'

describe('WalletAccountZcash', () => {
  it("derives m/44'/133'/0'/0/i (viem agrees on the key), accepts relative paths, exposes the chain id", async () => {
    const m = new WalletManagerZcash(SEED)
    const a = await m.getAccount(0)
    expect(a.path).toBe("m/44'/133'/0'/0/0")
    expect(a.index).toBe(0)
    expect(a.chain).toBe('zcash:mainnet')
    expect((await a.getAddress()).startsWith('t1')).toBe(true)
    expect(await m.getAccountByPath("0'/0/0")).toBe(a)
    for (const i of [0, 1, 4]) {
      const acc = await m.getAccount(i)
      const viemPub = mnemonicToAccount(SEED, { path: `m/44'/133'/0'/0/${i}` }).publicKey
      expect(hex(acc.publicKey)).toBe(hex(secp256k1.Point.fromHex(viemPub.slice(2)).toBytes(true)))
    }
    const t = new WalletManagerZcash(SEED, { network: 'testnet' })
    const ta = await t.getAccount(0)
    expect(ta.path).toBe("m/44'/1'/0'/0/0")
    expect((await ta.getAddress()).startsWith('tm')).toBe(true)
    expect(ta.chain).toBe('zcash:testnet')
    m.dispose(); t.dispose()
  })

  it('signs messages with the Zcash magic (header 31 + recovery, base64) and verify agrees', async () => {
    const m = new WalletManagerZcash(SEED)
    const a = await m.getAccount(0)
    const sig = await a.sign('hello')
    const bytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0))
    expect(bytes).toHaveLength(65)
    expect([31, 32, 33, 34]).toContain(bytes[0])
    expect(await a.verify('hello', sig)).toBe(true)
    expect(await a.verify('hellp', sig)).toBe(false)
    expect(await a.verify('hello', 'nope')).toBe(false)
    expect(hex(recoverMessagePublicKey('hello', sig)!)).toBe(hex(a.publicKey))
    m.dispose()
  })

  it('transfer selects UTXOs, builds a valid v5 tx with change, pays the ZIP-317 fee, sets lock time + expiry', async () => {
    const f = fakeBlockchair()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    const res = await a.transfer({ recipient: RECIPIENT, amount: 60_000_000n })
    expect(f.sent).toHaveLength(1)
    const tx = parseTx(f.sent[0]!)
    expect(res.hash).toBe(txid(tx))
    expect(res.fee).toBe(10_000n)
    expect(tx.consensusBranchId).toBe(0x37a5165b)
    expect(tx.lockTime).toBe(f.tip)
    expect(tx.expiryHeight).toBe(f.tip + 40)
    expect(tx.inputs.map((i) => `${i.txid}:${i.vout}`)).toEqual([`${TXID_A}:0`])
    const outs = tx.outputs.map((o) => ({ addr: decodeAddress(RECIPIENT, 'mainnet').script, value: o.value, script: hex(o.script) }))
    expect(outs[0]!.value).toBe(60_000_000n)
    expect(outs[0]!.script).toBe(hex(decodeAddress(RECIPIENT, 'mainnet').script))
    expect(outs[1]!.value).toBe(100_000_000n - 60_000_000n - 10_000n)
    expect(outs[1]!.script).toBe(hex(a.scriptPubKey))
    // the signature verifies under ZIP-244 for the spent output
    const sig = parseP2pkhScriptSig(tx.inputs[0]!.scriptSig)!
    expect(hex(sig.publicKey)).toBe(hex(a.publicKey))
    const digest = sighashAll(tx, 0, [{ value: 100_000_000n, script: a.scriptPubKey }])
    expect(secp256k1.verify(sig.signature, digest, sig.publicKey, { prehash: false, format: 'der' })).toBe(true)
    m.dispose()
  })

  it('quoteSendTransaction matches the fee the broadcast tx pays; describe names everything before anything is sent', async () => {
    const f = fakeBlockchair()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    expect((await a.quoteSendTransaction({ to: RECIPIENT, value: 120_000_000n })).fee).toBe(10_000n)
    const desc = await a.describeTransaction({ to: RECIPIENT, value: 120_000_000n })
    expect(desc.kind).toBe('zcash-transfer')
    expect(desc.inputs).toHaveLength(2)
    expect(desc.outputs.map((o) => o.role)).toEqual(['recipient', 'change'])
    expect(desc.amount).toBe(120_000_000n)
    expect(desc.fee).toBe(10_000n)
    expect(desc.conventionalFee).toBe(10_000n)
    expect(desc.txid).toBeDefined()
    expect(desc.warnings).toEqual([])
    expect(f.sent).toHaveLength(0)
    const res = await a.sendTransaction({ to: RECIPIENT, value: 120_000_000n })
    expect(res.fee).toBe(10_000n)
    expect(res.hash).toBe(desc.txid)
    m.dispose()
  })

  it('an explicit fee is honoured and warned about when below conventional; signTransaction hex re-broadcasts without re-signing', async () => {
    const f = fakeBlockchair()
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    const desc = await a.describeTransaction({ to: RECIPIENT, value: 60_000_000n, fee: 1_000n })
    expect(desc.fee).toBe(1_000n)
    expect(desc.warnings).toContain('fee-below-conventional')
    const raw = await a.signTransaction({ to: RECIPIENT, value: 60_000_000n })
    expect(f.sent).toHaveLength(0)
    // raw hex path: prevouts are looked up through the client
    const f2 = fakeBlockchair({ txs: { [TXID_A]: { outputs: [{ value: 100_000_000, script_hex: hex(a.scriptPubKey), recipient: a.address }] } } })
    const m2 = mk(f2.fetchFn)
    const a2 = await m2.getAccount(0)
    const res = await a2.sendTransaction(raw)
    expect(f2.sent).toEqual([raw])
    expect(res.hash).toBe(txid(parseTx(raw)))
    expect(res.fee).toBe(10_000n)
    m.dispose(); m2.dispose()
  })

  it('maxFee / transferMaxFee / transactionMaxFee stop before broadcast', async () => {
    const f = fakeBlockchair()
    const a = await mk(f.fetchFn, { transferMaxFee: 5_000n }).getAccount(0)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 60_000_000n })).rejects.toThrow(/maximum fee/)
    const b = await mk(f.fetchFn, { transactionMaxFee: 5_000 }).getAccount(0)
    await expect(b.sendTransaction({ to: RECIPIENT, value: 60_000_000n })).rejects.toThrow(/maximum fee/)
    const c = await mk(f.fetchFn, { maxFee: 50_000n }).getAccount(0)
    await expect(c.sendTransaction({ to: RECIPIENT, value: 60_000_000n, fee: 60_000n })).rejects.toThrow(UnsafeTransactionError)
    expect(f.sent).toHaveLength(0)
  })

  it('insufficient funds, dust, bad / shielded addresses and tokens are rejected', async () => {
    const f = fakeBlockchair()
    const a = await mk(f.fetchFn).getAccount(0)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 200_000_000n })).rejects.toThrow(InsufficientFundsError)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 100n })).rejects.toThrow(/dust/)
    await expect(a.transfer({ recipient: 'zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly', amount: 10_000n })).rejects.toThrow(/Sapling/)
    await expect(a.transfer({ recipient: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', amount: 10_000n })).rejects.toThrow(/Invalid Zcash address/)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 10_000n, token: 'x' })).rejects.toThrow(/Tokens/)
    const empty = await mk(fakeBlockchair({ utxos: [] }).fetchFn).getAccount(0)
    await expect(empty.transfer({ recipient: RECIPIENT, amount: 10_000n })).rejects.toThrow(InsufficientFundsError)
  })

  it('getMaxSpendable sweeps every input into one output; getBalance sums confirmed + mempool', async () => {
    const f = fakeBlockchair({ utxos: [
      { block_id: 3_500_000, transaction_hash: TXID_A, index: 0, value: 100_000_000 },
      { block_id: -1, transaction_hash: TXID_B, index: 1, value: 50_000_000 },
    ] })
    const a = await mk(f.fetchFn).getAccount(0)
    expect(await a.getBalance()).toBe(150_000_000n)
    const max = await a.getMaxSpendable()
    expect(max.inputs).toBe(2)
    expect(max.fee).toBe(10_000n)
    expect(max.amount).toBe(150_000_000n - 10_000n)
    expect(max.changeValue).toBe(0n)
    const r = await a.sendTransaction({ to: RECIPIENT, value: max.amount })
    expect(r.fee).toBe(10_000n)
    const tx = parseTx(f.sent[0]!)
    expect(tx.outputs).toHaveLength(1)
  })

  it('receipts: mined / unconfirmed / unknown; fee rates are the ZIP-317 marginal fee', async () => {
    const f = fakeBlockchair({ txs: { [TXID_A]: { outputs: [], block_id: 3_521_900, fee: 10_000 }, [TXID_B]: { outputs: [], block_id: -1 } } })
    const m = mk(f.fetchFn)
    const a = await m.getAccount(0)
    const r = await a.getTransactionReceipt(TXID_A)
    expect(r).toMatchObject({ status: 1, blockNumber: 3_521_900n, confirmations: 81, fee: 10_000n })
    expect(await a.getTransactionReceipt(TXID_B)).toBeUndefined()
    expect(await a.getTransactionReceipt('3'.repeat(64))).toBeUndefined()
    await expect(a.getTransactionReceipt('xyz')).rejects.toThrow(/valid transaction hash/)
    expect(await m.getFeeRates()).toEqual({ slow: 5_000n, normal: 5_000n, fast: 5_000n })
  })

  it("a node's broadcast rejection is final (no failover); transport failures walk the client list", async () => {
    const rejecting = fakeBlockchair({ rejectPush: 'TX decode failed' })
    const ok = fakeBlockchair()
    const m = new WalletManagerZcash(SEED, { client: [{ type: 'blockchair', clientConfig: { url: 'https://a.example/zcash' } }, { type: 'blockchair', clientConfig: { url: 'https://b.example/zcash' } }],
      fetch: ((input: string | URL | Request, init?: RequestInit) => (String(input).startsWith('https://a.example') ? rejecting.fetchFn(input, init) : ok.fetchFn(input, init))) as typeof fetch })
    const a = await m.getAccount(0)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 60_000_000n })).rejects.toThrow(/Broadcast rejected: TX decode failed/)
    expect(ok.sent).toHaveLength(0)
    const down = fakeBlockchair({ fail: true })
    const m2 = new WalletManagerZcash(SEED, { client: [{ type: 'blockchair', clientConfig: { url: 'https://a.example/zcash' } }, { type: 'blockchair', clientConfig: { url: 'https://b.example/zcash' } }],
      fetch: ((input: string | URL | Request, init?: RequestInit) => (String(input).startsWith('https://a.example') ? down.fetchFn(input, init) : ok.fetchFn(input, init))) as typeof fetch })
    const b = await m2.getAccount(0)
    expect(await b.getBalance()).toBe(150_000_000n)
    m.dispose(); m2.dispose()
  })

  it('malformed transport responses surface as NetworkError; offline wallet refuses network ops; read-only cannot sign; dispose kills signing', async () => {
    const bad = fakeBlockchair({ override: (p) => (p.startsWith('dashboards/address/') ? { nonsense: true } : undefined) })
    const a = await mk(bad.fetchFn).getAccount(0)
    await expect(a.getBalance()).rejects.toThrow(NetworkError)
    const offline = await new WalletManagerZcash(SEED).getAccount(0)
    await expect(offline.getBalance()).rejects.toThrow(/connected to a client/)
    await expect(offline.transfer({ recipient: RECIPIENT, amount: 10_000n })).rejects.toThrow(/connected to a client/)
    const ro = offline.toReadOnlyAccount() as Partial<typeof offline>
    expect(ro.sendTransaction).toBeUndefined()
    expect(ro.sign).toBeUndefined()
    const m = new WalletManagerZcash(SEED)
    const acc = await m.getAccount(0)
    m.dispose()
    await expect(acc.sign('x')).rejects.toThrow()
  })

  it('watch-only accounts on a P2SH (t3) address read balances but cannot plan spends', async () => {
    const f = fakeBlockchair()
    const ro = mk(f.fetchFn).getReadOnlyAccount('t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd')
    expect(await ro.getBalance()).toBe(150_000_000n)
    await expect(ro.quoteSendTransaction({ to: RECIPIENT, value: 10_000n })).rejects.toThrow(/only P2PKH/)
  })
})
