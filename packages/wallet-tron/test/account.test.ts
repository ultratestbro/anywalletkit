import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { WalletManagerTron, encodeParameters, selector, toHexAddress, type TronFetch, type TronRawTransaction } from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH' // golden vector, account 0
const RECIPIENT = 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK' // account 1
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

/** Fake full node: builds plausible raw transactions (raw_data_hex arbitrary, txID = sha256 of it) and records calls. */
function fakeNode(overrides: Record<string, (body: Record<string, unknown>) => unknown> = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const broadcast: TronRawTransaction[] = []
  let n = 0
  const rawTx = (type: string, value: Record<string, unknown>, extra: Record<string, unknown> = {}): TronRawTransaction => {
    const raw_data_hex = '0a02' + (++n).toString(16).padStart(4, '0') + 'ab'.repeat(60)
    return { txID: bytesToHex(sha256(hexToBytes(raw_data_hex))), raw_data_hex, raw_data: { contract: [{ type, parameter: { value } }], ...extra }, visible: false }
  }
  const handlers: Record<string, (body: Record<string, unknown>) => unknown> = {
    '/wallet/createtransaction': (b) => rawTx('TransferContract', { owner_address: b.owner_address, to_address: b.to_address, amount: b.amount }),
    '/wallet/triggersmartcontract': (b) => ({ result: { result: true }, transaction: rawTx('TriggerSmartContract', { owner_address: b.owner_address, contract_address: b.contract_address, data: selector(String(b.function_selector)) + b.parameter }, { fee_limit: b.fee_limit }) }),
    '/wallet/triggerconstantcontract': (b) => ({ result: { result: true }, energy_used: 30_000, constant_result: ['0'.repeat(63) + '5'], transaction: rawTx('TriggerSmartContract', { owner_address: b.owner_address, contract_address: b.contract_address, data: b.data ?? '' }) }),
    '/wallet/getaccount': (b) => (b.address === toHexAddress(RECIPIENT) ? {} : { address: b.address, balance: 5_000_000 }),
    '/wallet/getaccountresource': () => ({ freeNetLimit: 600, freeNetUsed: 0, EnergyLimit: 0, EnergyUsed: 0 }),
    '/wallet/getchainparameters': () => ({ chainParameter: [{ key: 'getTransactionFee', value: 1000 }, { key: 'getEnergyFee', value: 210 }] }),
    '/wallet/broadcasttransaction': (b) => { broadcast.push(b as unknown as TronRawTransaction); return { result: true, txid: b.txID } },
    '/wallet/gettransactioninfobyid': () => ({}),
    ...overrides,
  }
  const fetch: TronFetch = async (path, body) => { const b = body as Record<string, unknown>; calls.push({ path, body: b }); const h = handlers[path]; if (!h) throw new Error(`unmocked ${path}`); return h(b) }
  return { fetch, calls, broadcast, paths: () => calls.map((c) => c.path) }
}

const verifyTx = (tx: TronRawTransaction, pub: Uint8Array) => {
  const sig = hexToBytes(tx.signature![0]!)
  expect(sig).toHaveLength(65)
  return secp256k1.verify(sig.slice(0, 64), hexToBytes(tx.txID), pub, { prehash: false })
}

describe('WalletAccountTron', () => {
  it('derives account 0, accepts relative paths, exposes hex address', async () => {
    const m = new WalletManagerTron(SEED)
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(ADDR0)
    expect(a.index).toBe(0)
    expect(a.chain).toBe('tron:0x2b6653dc')
    expect(a.addressHex).toMatch(/^41[0-9a-f]{40}$/)
    expect(await m.getAccountByPath("0'/0/0")).toBe(a)
    m.dispose()
  })

  it('sign is TIP-191 with v=27/28 and verify agrees', async () => {
    const m = new WalletManagerTron(SEED)
    const a = await m.getAccount(0)
    const sig = await a.sign('hi')
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    expect(['1b', '1c']).toContain(sig.slice(-2))
    expect(await a.verify('hi', sig)).toBe(true)
    expect(await a.verify('ho', sig)).toBe(false)
    m.dispose()
  })

  it('TRX transfer: createtransaction → sign txID → broadcast; fee = bandwidth + activation when recipient is new', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const res = await a.transfer({ recipient: RECIPIENT, amount: 1_000_000n })
    expect(f.paths()[0]).toBe('/wallet/createtransaction')
    expect(f.calls[0]!.body).toMatchObject({ owner_address: a.addressHex, to_address: toHexAddress(RECIPIENT), amount: 1_000_000 })
    expect(f.broadcast).toHaveLength(1)
    const tx = f.broadcast[0]!
    expect(verifyTx(tx, a.publicKey)).toBe(true)
    expect(res.hash).toBe(tx.txID)
    // recipient account is empty → activation: 1 TRX + 100_000 sun bandwidth
    expect(res.activationFee).toBe(1_000_000n)
    expect(res.fee).toBe(1_100_000n)
    m.dispose()
  })

  it('TRC-20 transfer: triggersmartcontract with transfer(address,uint256) selector and ABI params', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const res = await a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1_000_000n })
    const sim = f.calls.find((c) => c.path === '/wallet/triggerconstantcontract')!
    expect(sim.body.function_selector).toBe('transfer(address,uint256)')
    const build = f.calls.find((c) => c.path === '/wallet/triggersmartcontract')!
    expect(build.body).toMatchObject({ owner_address: a.addressHex, contract_address: toHexAddress(USDT), function_selector: 'transfer(address,uint256)', call_value: 0 })
    expect(build.body.parameter).toBe(encodeParameters([{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 1_000_000n }]))
    expect(String(build.body.parameter)).toBe(toHexAddress(RECIPIENT).slice(2).padStart(64, '0') + (1_000_000n).toString(16).padStart(64, '0'))
    expect(selector('transfer(address,uint256)')).toBe('a9059cbb')
    expect(f.broadcast).toHaveLength(1)
    expect(verifyTx(f.broadcast[0]!, a.publicKey)).toBe(true)
    // 30_000 energy × 210 sun, free bandwidth covers the tx
    expect(res.fee).toBe(6_300_000n)
    expect(build.body.fee_limit).toBe(6_300_000)
    m.dispose()
  })

  it('getTokenBalance / getAllowance decode constant_result', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    expect(await a.getTokenBalance(USDT)).toBe(5n)
    expect(f.calls[0]!.body.function_selector).toBe('balanceOf(address)')
    expect(await a.getAllowance(USDT, RECIPIENT)).toBe(5n)
    expect(await a.getBalance()).toBe(5_000_000n)
    m.dispose()
  })

  it('transferMaxFee / transactionMaxFee stop before broadcast', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch, transferMaxFee: 1n, transactionMaxFee: 1n })
    const a = await m.getAccount(0)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/maximum fee/)
    await expect(a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/maximum fee/)
    await expect(a.sendTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(/maximum fee/)
    await expect(a.signTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(/maximum fee/)
    expect(f.broadcast).toHaveLength(0)
    m.dispose()
  })

  it('signTransaction returns broadcast-ready JSON that sendTransaction re-broadcasts without re-signing; owner mismatch is refused', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const signed = await a.signTransaction({ contractAddress: USDT, functionSelector: 'approve(address,uint256)', parameters: [{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 7n }] })
    const parsed = JSON.parse(signed) as TronRawTransaction
    expect(parsed.signature).toHaveLength(1)
    const res = await a.sendTransaction(signed)
    expect(res.hash).toBe(parsed.txID)
    expect(f.broadcast[0]!.signature).toEqual(parsed.signature)
    const foreign = { ...parsed, signature: undefined, raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: toHexAddress(RECIPIENT) } } }] } }
    await expect(a.sendTransaction(foreign as never)).rejects.toThrow(/owner/)
    m.dispose()
  })

  it('failover walks the provider list; getFeeRates uses getTransactionFee', async () => {
    const dead: TronFetch = async () => { throw new Error('boom') }
    const alive = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: [dead, alive.fetch] })
    expect(await (await m.getAccount(0)).getBalance()).toBe(5_000_000n)
    expect(await m.getFeeRates()).toEqual({ slow: 1000n, normal: 1100n, fast: 2000n })
    m.dispose()
  })

  it('receipt: undefined when unknown, status from receipt.result', async () => {
    const f = fakeNode({ '/wallet/gettransactioninfobyid': (b) => (b.value === 'aa' ? { id: 'aa', blockNumber: 42, fee: 300, receipt: { result: 'SUCCESS' } } : b.value === 'bb' ? { id: 'bb', blockNumber: 43, result: 'FAILED', receipt: { result: 'REVERT' } } : {}) })
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    expect(await a.getTransactionReceipt('zz')).toBeUndefined()
    expect(await a.getTransactionReceipt('aa')).toMatchObject({ status: 1, blockNumber: 42n, fee: 300n })
    expect((await a.getTransactionReceipt('bb'))!.status).toBe(0)
    m.dispose()
  })

  it('offline wallet refuses network ops; read-only cannot sign; dispose kills signing', async () => {
    const m = new WalletManagerTron(SEED)
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
