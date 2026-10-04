import '../src/buffer-global.js' // before @ton/ton: it reads the global Buffer at module init
import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { Buffer } from 'buffer'
import { Address, Cell, TonClient, beginCell, loadMessage } from '@ton/ton'
import { WalletManagerTon } from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'UQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLtaT' // golden vector, account 0
const RECIPIENT = 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi' // account 1
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const JETTON_WALLET = new Address(0, Buffer.alloc(32, 7)).toString()

/** A TonClient whose low-level HTTP `api` is faked: toncenter v2 JSON shapes, calls recorded. */
function fakeClient(overrides: Record<string, (...a: unknown[]) => unknown> = {}) {
  const sent: Buffer[] = []
  const calls: string[] = []
  const walletData = beginCell().storeAddress(Address.parse(JETTON_WALLET)).endCell().toBoc().toString('base64')
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getAddressInformation: () => ({ '@type': 'raw.fullAccountState', balance: '1000000000', state: 'active', code: 'te6cckEBAQEAAgAAAEysuc0=', data: 'te6cckEBAQEAAgAAAEysuc0=', last_transaction_id: { '@type': 'internal.transactionId', lt: '1', hash: 'AA==' }, block_id: { '@type': 'ton.blockIdExt', workchain: -1, shard: '0', seqno: 1, root_hash: 'AA==', file_hash: 'AA==' }, sync_utime: 1 }),
    callGetMethod: (_addr: unknown, method: unknown) => {
      if (method === 'seqno') return { '@type': 'smc.runResult', gas_used: 1, exit_code: 0, stack: [['num', '0x7']] }
      if (method === 'get_wallet_address') return { '@type': 'smc.runResult', gas_used: 1, exit_code: 0, stack: [['cell', { bytes: walletData }]] }
      if (method === 'get_wallet_data') return { '@type': 'smc.runResult', gas_used: 1, exit_code: 0, stack: [['num', '0x3e8']] }
      throw new Error(`unmocked get method ${String(method)}`)
    },
    estimateFee: () => ({ '@type': 'query.fees', source_fees: { '@type': 'fees', in_fwd_fee: 1000, storage_fee: 10, gas_fee: 2000, fwd_fee: 100 }, destination_fees: [] }),
    sendBoc: (boc: unknown) => { sent.push(boc as Buffer); return {} },
    ...overrides,
  }
  const client = new TonClient({ endpoint: 'http://fake' })
  const c = client as unknown as { api: Record<string, unknown> }
  c.api = new Proxy(c.api, { get: (_t, m: string) => async (...args: unknown[]) => { calls.push(m); const h = handlers[m]; if (!h) throw new Error(`unmocked api.${m}`); return h(...args) } })
  return { client, sent, calls }
}

/** Verify a V5R1 external message: signature is the last 512 bits of the body, over the hash of the rest (+ refs). */
function verifyExternal(boc: Buffer, pub: Uint8Array, expectedTo: string) {
  const cell = Cell.fromBoc(boc)[0]!
  const msg = loadMessage(cell.beginParse())
  expect(msg.info.type).toBe('external-in')
  if (msg.info.type === 'external-in') expect(msg.info.dest.toString({ bounceable: false })).toBe(expectedTo)
  const s = msg.body.beginParse()
  const payload = s.loadBits(s.remainingBits - 512)
  const sig = s.loadBits(512)
  const signing = beginCell().storeBits(payload)
  for (const r of msg.body.refs) signing.storeRef(r)
  const sigBytes = new Uint8Array(beginCell().storeBits(sig).endCell().beginParse().loadBuffer(64)) // re-align: the payload is not byte-aligned
  const ok = ed25519.verify(sigBytes, signing.endCell().hash(), pub)
  expect(ok).toBe(true)
  return msg
}

describe('WalletAccountTon', () => {
  it('derives account 0, relative paths, caip-2', async () => {
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

  it('native transfer: signed V5R1 external to self, body hash returned, fee summed from estimateFee', async () => {
    const f = fakeClient()
    const m = new WalletManagerTon(SEED, { tonClient: f.client })
    const a = await m.getAccount(0)
    const res = await a.transfer({ recipient: RECIPIENT, amount: 100_000_000n })
    expect(res.fee).toBe(3110n)
    expect(f.sent).toHaveLength(1)
    const msg = verifyExternal(f.sent[0]!, a.publicKey, ADDR0)
    expect(msg.body.hash().toString('hex')).toBe(res.hash)
    expect(f.calls).toContain('sendBoc')
    m.dispose()
  })

  it('jetton transfer resolves the jetton wallet and sends a 0x0f8a7ea5 body to it', async () => {
    const f = fakeClient()
    const m = new WalletManagerTon(SEED, { tonClient: f.client })
    const a = await m.getAccount(0)
    const res = await a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1_000_000n })
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/)
    const msg = verifyExternal(f.sent[0]!, a.publicKey, ADDR0)
    // V5R1 body: 32 op | 32 wallet_id | 32 valid_until | 32 seqno | actions ref → out_list with our internal message
    const actions = msg.body.refs[0]!
    const boc = actions.toBoc().toString('hex')
    expect(boc).toContain('0f8a7ea5')
    expect(await a.getTokenBalance(USDT)).toBe(1000n)
    m.dispose()
  })

  it('sendTransaction accepts {to, value, body} and a prebuilt Cell', async () => {
    const f = fakeClient()
    const m = new WalletManagerTon(SEED, { tonClient: f.client })
    const a = await m.getAccount(0)
    const r1 = await a.sendTransaction({ to: RECIPIENT, value: 1n, body: 'hello' })
    const boc = await a.signTransaction({ to: RECIPIENT, value: 2n })
    const r2 = await a.sendTransaction(Cell.fromBase64(boc))
    expect(r1.hash).not.toBe(r2.hash)
    expect(f.sent).toHaveLength(2)
    m.dispose()
  })

  it('max fees stop before broadcast', async () => {
    const f = fakeClient()
    const m = new WalletManagerTon(SEED, { tonClient: f.client, transferMaxFee: 1n, transactionMaxFee: 1n })
    const a = await m.getAccount(0)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/maximum fee/)
    await expect(a.sendTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(/maximum fee/)
    expect(f.sent).toHaveLength(0)
    m.dispose()
  })

  it('failover walks the client list', async () => {
    const dead = fakeClient({ getAddressInformation: () => { throw new Error('boom') } })
    const alive = fakeClient()
    const m = new WalletManagerTon(SEED, { tonClient: [dead.client, alive.client] })
    expect(await (await m.getAccount(0)).getBalance()).toBe(1_000_000_000n)
    expect(dead.calls).toEqual(['getAddressInformation'])
    expect(alive.calls).toEqual(['getAddressInformation'])
    m.dispose()
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
})
