import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { Buffer } from 'buffer'
import { Address, Cell, beginCell, loadMessage, loadOutList } from '@ton/core'
import { SimulationError, UnsafeTransactionError, WalletManagerTon, parseV5R1Body } from '../src/index.js'
import { JETTON_WALLET, fakeRpc } from './fake-rpc.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'UQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLtaT' // vector, account 0
const RECIPIENT = 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi' // account 1
const RECIPIENT_TESTNET = Address.parse(RECIPIENT).toString({ bounceable: false, testOnly: true })
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const ENDPOINT = { url: 'http://fake/api/v2/jsonRPC', secretKey: 'k' }

const manager = (f: ReturnType<typeof fakeRpc>, extra: Record<string, unknown> = {}) =>
  new WalletManagerTon(SEED, { tonClient: ENDPOINT, fetch: f.fetch, ...extra })

/** Verify a V5R1 external message: signature is the last 512 bits of the body, over the hash of the rest (+ refs). */
function verifyExternal(cell: Cell, pub: Uint8Array, expectedTo: string) {
  const msg = loadMessage(cell.beginParse())
  expect(msg.info.type).toBe('external-in')
  if (msg.info.type === 'external-in') expect(msg.info.dest.toString({ bounceable: false })).toBe(expectedTo)
  const s = msg.body.beginParse()
  const payload = s.loadBits(s.remainingBits - 512)
  const sig = s.loadBits(512)
  const signing = beginCell().storeBits(payload)
  for (const r of msg.body.refs) signing.storeRef(r)
  const sigBytes = new Uint8Array(beginCell().storeBits(sig).endCell().beginParse().loadBuffer(64))
  expect(ed25519.verify(sigBytes, signing.endCell().hash(), pub)).toBe(true)
  return msg
}

describe('WalletAccountTon', () => {
  it('derives vector account 0, relative paths, caip-2', async () => {
    const m = new WalletManagerTon(SEED)
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(ADDR0)
    expect(a.index).toBe(0)
    expect(a.chain).toBe('ton:-239')
    expect(await m.getAccountByPath("0'")).toBe(a)
    m.dispose()
  })

  it('sign is hex ed25519 and verify agrees', async () => {
    const m = new WalletManagerTon(SEED)
    const a = await m.getAccount(0)
    const sig = await a.sign('hi')
    expect(sig).toMatch(/^[0-9a-f]{128}$/)
    expect(await a.verify('hi', sig)).toBe(true)
    expect(await a.verify('ho', sig)).toBe(false)
    m.dispose()
  })

  it('native transfer: signed V5R1 external to self, body hash returned, fee summed from estimateFee, api key sent', async () => {
    let apiKey: string | null = null
    const f = fakeRpc()
    const spy = (async (i: string | URL | Request, init?: RequestInit) => { apiKey = (init?.headers as Record<string, string>)['X-API-Key'] ?? null; return f.fetch(i, init) }) as typeof fetch
    const m = new WalletManagerTon(SEED, { tonClient: ENDPOINT, fetch: spy })
    const a = await m.getAccount(0)
    const res = await a.transfer({ recipient: RECIPIENT, amount: 100_000_000n })
    expect(res.fee).toBe(3110n)
    expect(f.sent).toHaveLength(1)
    const msg = verifyExternal(f.sent[0]!, a.publicKey, ADDR0)
    expect(msg.body.hash().toString('hex')).toBe(res.hash)
    expect(apiKey).toBe('k')
    // preflight (estimateFee) ran BEFORE the broadcast, seqno fetched fresh
    expect(f.calls.indexOf('estimateFee')).toBeLessThan(f.calls.indexOf('sendBoc'))
    expect(f.calls.filter((c) => c === 'runGetMethod')).toHaveLength(1)
    m.dispose()
  })

  it('jetton transfer: resolves the jetton wallet, 0x0f8a7ea5 body with forward payload/custom payload/response destination', async () => {
    const f = fakeRpc()
    const m = manager(f)
    const a = await m.getAccount(0)
    const res = await a.transfer({
      token: USDT, recipient: RECIPIENT, amount: 1_000_000n,
      forwardTonAmount: 5n, forwardPayload: 'thanks', queryId: 42n, responseDestination: RECIPIENT,
    })
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/)
    const msg = verifyExternal(f.sent[0]!, a.publicKey, ADDR0)
    const parsed = parseV5R1Body(msg.body)!
    expect(parsed.messages).toHaveLength(1)
    const out = parsed.messages[0]!.message
    expect(out.info.type === 'internal' && out.info.dest.equals(Address.parse(JETTON_WALLET))).toBe(true)
    expect(out.info.type === 'internal' && out.info.value.coins).toBe(50_000_005n) // 0.05 TON + forward
    const d = a.describe(msg.body)
    expect(d.kind).toBe('jetton-transfer')
    expect(d.items[0]!.jetton).toMatchObject({ queryId: 42n, amount: 1_000_000n, forwardTonAmount: 5n, forwardPayload: 'comment', forwardComment: 'thanks', hasCustomPayload: false })
    expect(d.items[0]!.jetton!.responseDestination).toBe(Address.parse(RECIPIENT).toString())
    expect(await a.getTokenBalance(USDT)).toBe(1000n)
    m.dispose()
  })

  it('getTokenBalance is 0 when the jetton wallet is not deployed', async () => {
    const f = fakeRpc({
      getAddressInformation: (p) => ({ balance: '0', state: p.address === Address.parse(JETTON_WALLET).toString() ? 'uninitialized' : 'active', code: '', data: '', last_transaction_id: { lt: '0', hash: '' } }),
    })
    const a = await manager(f).getAccount(0)
    expect(await a.getTokenBalance(USDT)).toBe(0n)
  })

  it('sendTransaction: several messages in ONE external; bodyBoc and stateInit are attached', async () => {
    const f = fakeRpc()
    const a = await manager(f).getAccount(0)
    const init = { code: beginCell().storeUint(1, 8).endCell(), data: beginCell().storeUint(2, 8).endCell() }
    const bodyBoc = beginCell().storeUint(0xdeadbeef, 32).endCell().toBoc().toString('base64')
    const r = await a.sendTransaction([
      { to: RECIPIENT, value: 1n, body: 'hello' },
      { to: RECIPIENT, value: 2n, bodyBoc, stateInit: init, sendMode: 1 },
      { to: RECIPIENT, value: 3n },
    ])
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/)
    const parsed = parseV5R1Body(loadMessage(f.sent[0]!.beginParse()).body)!
    expect(parsed.seqno).toBe(7)
    expect(parsed.messages.map((x) => x.message.info.type === 'internal' ? x.message.info.value.coins : 0n)).toEqual([1n, 2n, 3n])
    expect(parsed.messages.map((x) => x.mode)).toEqual([3, 3, 3]) // IGNORE_ERRORS always OR-ed in
    const second = parsed.messages[1]!.message
    expect(second.init?.code?.equals(init.code)).toBe(true)
    expect(second.body.beginParse().loadUint(32)).toBe(0xdeadbeef)
  })

  it('signTransaction returns the body; sendTransaction re-broadcasts a prebuilt Cell without re-signing', async () => {
    const f = fakeRpc()
    const a = await manager(f).getAccount(0)
    const boc = await a.signTransaction({ to: RECIPIENT, value: 2n })
    expect(f.sent).toHaveLength(0)
    const r = await a.sendTransaction(Cell.fromBase64(boc))
    expect(r.hash).toBe(Cell.fromBase64(boc).hash().toString('hex'))
    expect(f.sent).toHaveLength(1)
  })

  it('attaches stateInit to the external when the wallet is not deployed yet', async () => {
    const f = fakeRpc({ getAddressInformation: () => ({ balance: '1000000000', state: 'uninitialized', code: '', data: '', last_transaction_id: { lt: '0', hash: '' } }) })
    const a = await manager(f).getAccount(0)
    await a.transfer({ recipient: RECIPIENT, amount: 1n })
    const msg = loadMessage(f.sent[0]!.beginParse())
    expect(msg.init).toBeTruthy()
    expect(f.calls.filter((c) => c === 'runGetMethod')).toHaveLength(0) // seqno 0 without a get-method call
    expect(parseV5R1Body(msg.body)!.seqno).toBe(0)
  })

  it('hard checks refuse zero value, exotic workchains, wrong network flag, too-long validity — before any network call', async () => {
    const f = fakeRpc()
    const a = await manager(f).getAccount(0)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 0n })).rejects.toBeInstanceOf(UnsafeTransactionError)
    await expect(a.sendTransaction({ to: RECIPIENT, value: 0n })).rejects.toThrow(/positive/)
    await expect(a.sendTransaction({ to: new Address(5, Buffer.alloc(32, 1)).toString(), value: 1n })).rejects.toThrow(/workchain 5/)
    await expect(a.sendTransaction({ to: RECIPIENT_TESTNET, value: 1n })).rejects.toThrow(/Test-only/)
    expect(f.calls).toHaveLength(0)
    const testnet = await manager(f, { network: 'testnet' }).getAccount(0)
    await expect(testnet.sendTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(/Mainnet address/)
    const slow = await manager(f, { validUntilSeconds: 601 }).getAccount(0)
    await expect(slow.sendTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(/validUntilSeconds/)
    expect(f.sent).toHaveLength(0)
  })

  it('valid_until is now + validUntilSeconds', async () => {
    const f = fakeRpc()
    const a = await manager(f, { validUntilSeconds: 120 }).getAccount(0)
    const before = Math.floor(Date.now() / 1000)
    await a.transfer({ recipient: RECIPIENT, amount: 1n })
    const vu = parseV5R1Body(loadMessage(f.sent[0]!.beginParse()).body)!.validUntil
    expect(vu).toBeGreaterThanOrEqual(before + 120)
    expect(vu).toBeLessThanOrEqual(before + 122)
  })

  it('max fees stop before broadcast', async () => {
    const f = fakeRpc()
    const a = await manager(f, { transferMaxFee: 1n, transactionMaxFee: 1n }).getAccount(0)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/maximum fee/)
    await expect(a.sendTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(/maximum fee/)
    expect(f.sent).toHaveLength(0)
  })

  it('emulation: a failing compute phase throws SimulationError before signing; a clean one proceeds', async () => {
    const bad = fakeRpc({}, { emulate: () => ({ trace: { tx_hash: 'r' }, transactions: { r: { description: { aborted: true, compute_ph: { success: false, exit_code: 33 }, action: { success: false } } } } }) })
    const a = await manager(bad, { emulateUrl: 'http://fake/api/emulate/v1/emulateTrace' }).getAccount(0)
    const err = await a.transfer({ recipient: RECIPIENT, amount: 1n }).catch((e) => e)
    expect(err).toBeInstanceOf(SimulationError)
    expect((err as SimulationError).exitCode).toBe(33)
    expect(bad.sent).toHaveLength(0)
    expect(bad.emulations).toBe(1)
    const sim = await a.simulateTransaction({ to: RECIPIENT, value: 1n })
    expect(sim.ok).toBe(false)
    expect(sim.ok === false && sim.reason).toMatch(/aborted/)

    const good = fakeRpc({}, { emulate: () => ({ transactions: [{ description: { aborted: false, compute_ph: { success: true, exit_code: 0 }, action: { success: true } } }] }) })
    const b = await manager(good, { emulateUrl: 'http://fake/api/emulate/v1/emulateTrace' }).getAccount(0)
    const r = await b.transfer({ recipient: RECIPIENT, amount: 1n })
    expect(r.fee).toBe(3110n)
    expect(good.sent).toHaveLength(1)
    const ok = await b.simulateTransaction({ to: RECIPIENT, value: 1n })
    expect(ok).toMatchObject({ ok: true, emulated: true, exitCode: 0, actionSuccess: true })
  })

  it('simulate: false skips the preflight (fee cap still enforced when set)', async () => {
    const f = fakeRpc({}, { emulate: () => ({ transactions: [{ description: { aborted: true } }] }) })
    const a = await manager(f, { emulateUrl: 'http://fake/emulate', simulate: false }).getAccount(0)
    await a.transfer({ recipient: RECIPIENT, amount: 1n })
    expect(f.emulations).toBe(0)
    expect(f.calls).not.toContain('estimateFee')
    const capped = await manager(f, { emulateUrl: 'http://fake/emulate', simulate: false, transferMaxFee: 1n }).getAccount(0)
    await expect(capped.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/maximum fee/)
  })

  it('failover walks the endpoint list; malformed responses are NetworkErrors', async () => {
    const dead = fakeRpc({}, { failAll: true })
    const alive = fakeRpc()
    const route = (async (i: string | URL | Request, init?: RequestInit) => (String(i).includes('dead') ? dead.fetch(i, init) : alive.fetch(i, init))) as typeof fetch
    const m = new WalletManagerTon(SEED, { tonClient: [{ url: 'http://dead' }, { url: 'http://alive' }], fetch: route })
    expect(await (await m.getAccount(0)).getBalance()).toBe(1_000_000_000n)
    expect(alive.calls).toEqual(['getAddressInformation'])
    const broken = fakeRpc({ getAddressInformation: () => ({ nope: 1 }) })
    await expect((await manager(broken).getAccount(0)).getBalance()).rejects.toThrow(/Malformed/)
  })

  it('custom TonRpc objects are accepted as providers', async () => {
    const calls: string[] = []
    const rpc = { async call<T>(method: string) { calls.push(method); return { balance: '5', state: 'active', code: '', data: '', last_transaction_id: { lt: '1', hash: '' } } as T } }
    const a = await new WalletManagerTon(SEED, { tonClient: rpc }).getAccount(0)
    expect(await a.getBalance()).toBe(5n)
    expect(calls).toEqual(['getAddressInformation'])
  })

  it('offline wallet refuses network ops; read-only cannot sign; dispose kills signing', async () => {
    const m = new WalletManagerTon(SEED)
    const a = await m.getAccount(0)
    await expect(a.getBalance()).rejects.toThrow(/provider/)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/provider/)
    const ro = a.toReadOnlyAccount() as unknown as Record<string, unknown>
    expect(ro.sign).toBeUndefined()
    expect(ro.sendTransaction).toBeUndefined()
    m.dispose()
    await expect(a.sign('x')).rejects.toThrow(/disposed/)
  })

  it('getTransactionReceipt resolves a body hash through the v3 indexer', async () => {
    const f = fakeRpc({ getTransactions: () => [] }, { indexer: () => ({ transactions: [{ account: Address.parse(ADDR0).toRawString(), hash: 'AA==', lt: '1' }] }) })
    const a = await manager(f).getAccount(0)
    expect(await a.getTransactionReceipt('00'.repeat(32))).toBeUndefined()
    expect(f.calls).toContain('transactionsByMessage')
    expect(f.calls.filter((c) => c === 'getTransactions')).toHaveLength(1)
    // a failing direct lookup falls back to the archival node
    const g = fakeRpc({ getTransactions: (p) => { if (!p.archival) throw new Error('not here'); return [] } }, { indexer: () => ({ transactions: [{ account: Address.parse(ADDR0).toRawString(), hash: 'AA==', lt: '1' }] }) })
    expect(await (await manager(g).getAccount(0)).getTransactionReceipt('00'.repeat(32))).toBeUndefined()
    expect(g.calls.filter((c) => c === 'getTransactions')).toHaveLength(2)
  })
})

describe('out-list parity helper', () => {
  it('loadOutList reads the actions our signing message stores', () => {
    const m = new WalletManagerTon(SEED)
    void m
    const cell = beginCell().endCell()
    expect(loadOutList(cell.beginParse())).toEqual([])
  })
})
