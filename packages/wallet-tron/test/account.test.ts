import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decodeRawData, encodeRawData,
  SimulationError, UnsafeTransactionError, WalletManagerTron, ZERO_ADDRESS, bandwidthPoints, describeTransaction, encodeParameters,
  hashMessage, recoverMessageAddress, selector, toHexAddress, type TronFetch, type TronRawTransaction,
} from '../src/index.js'
import { NOW, RECIPIENT, fakeNode, seal } from './fake-node.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH' // conformance vector, account 0
const EXISTING = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9' // "existing" account in the fake node
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

/** Error(string) ABI payload. */
function errorString(msg: string): string {
  const bytes = new TextEncoder().encode(msg)
  const padded = bytesToHex(bytes).padEnd(Math.ceil(bytes.length / 32) * 64, '0')
  return '08c379a0' + (32n).toString(16).padStart(64, '0') + BigInt(bytes.length).toString(16).padStart(64, '0') + padded
}

const verifyTx = (tx: TronRawTransaction, pub: Uint8Array) => {
  const sig = hexToBytes(tx.signature![0]!)
  expect(sig).toHaveLength(65)
  return secp256k1.verify(sig.slice(0, 64), hexToBytes(tx.txID), pub, { prehash: false })
}

/** Freeze Date.now() so expiration checks are deterministic. */
const withNow = async <T>(fn: () => Promise<T>): Promise<T> => {
  const real = Date.now
  Date.now = () => NOW
  try { return await fn() } finally { Date.now = real }
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

  it('TIP-191: hash is keccak("\\x19TRON Signed Message:\\n" + len + msg); sign/verify/recover agree; v is 27/28', async () => {
    const msg = 'hello'
    const expected = keccak_256(new TextEncoder().encode(`\x19TRON Signed Message:\n5${msg}`))
    expect(bytesToHex(hashMessage(msg))).toBe(bytesToHex(expected))
    expect(bytesToHex(hashMessage(new TextEncoder().encode(msg)))).toBe(bytesToHex(expected))
    const m = new WalletManagerTron(SEED)
    const a = await m.getAccount(0)
    const sig = await a.sign(msg)
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    expect(['1b', '1c']).toContain(sig.slice(-2))
    expect(recoverMessageAddress(msg, sig)).toBe(ADDR0)
    expect(await a.verify(msg, sig)).toBe(true)
    expect(await a.verify('ho', sig)).toBe(false)
    // 0/1 recovery byte encoding is accepted too; a foreign account rejects
    const v01 = sig.slice(0, -2) + (parseInt(sig.slice(-2), 16) - 27).toString(16).padStart(2, '0')
    expect(await a.verify(msg, v01)).toBe(true)
    expect(await m.getReadOnlyAccount(RECIPIENT).verify(msg, sig)).toBe(false)
    expect(recoverMessageAddress(msg, '0x1234')).toBeUndefined()
    m.dispose()
  })

  it('bandwidth formula: serialized envelope + signature + 64-byte result reserve (268 for a TRX transfer)', () => {
    expect(bandwidthPoints('ab'.repeat(134))).toBe(268)
    expect(bandwidthPoints('ab'.repeat(211))).toBe(345)
    expect(bandwidthPoints('ab'.repeat(100))).toBe(1 + 1 + 100 + 67 + 64)
    expect(bandwidthPoints('ab'.repeat(134), 2)).toBe(268 + 67)
  })

  it('TRX transfer to a NEW account: creation fee 1 TRX + 0.1 TRX (no staked bandwidth), no bandwidth burn', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const res = await withNow(() => a.transfer({ recipient: RECIPIENT, amount: 1_000_000n }))
    expect(f.paths()[0]).toBe('/wallet/createtransaction')
    expect(f.calls[0]!.body).toMatchObject({ owner_address: a.addressHex, to_address: toHexAddress(RECIPIENT), amount: 1_000_000 })
    expect(f.broadcast).toHaveLength(1)
    expect(verifyTx(f.broadcast[0]!, a.publicKey)).toBe(true)
    expect(res.hash).toBe(f.broadcast[0]!.txID)
    expect(res.activationFee).toBe(1_100_000n)
    expect(res.fee).toBe(1_100_000n)
    expect(res.estimate).toMatchObject({ bandwidth: bandwidthPoints(f.broadcast[0]!.raw_data_hex), energy: 0, trxBurn: 1_100_000n, breakdown: { bandwidthFree: 600, bandwidthStaked: 0, bandwidthBurn: 0n, energyBurn: 0n, memoFee: 0n, accountCreationFee: 1_100_000n, bandwidthPrice: 1000n, energyPrice: 210n } })
    m.dispose()
  })

  it('TRX transfer to an EXISTING account: staked → free → burn at getTransactionFee per byte', async () => {
    const covered = fakeNode()
    const m1 = new WalletManagerTron(SEED, { provider: covered.fetch })
    const r1 = await withNow(async () => (await m1.getAccount(0)).transfer({ recipient: EXISTING, amount: 1_000_000n }))
    expect(r1.fee).toBe(0n)
    expect(r1.activationFee).toBe(0n)
    m1.dispose()

    const exhausted = fakeNode({}, { resources: { freeNetLimit: 600, freeNetUsed: 600 } })
    const m2 = new WalletManagerTron(SEED, { provider: exhausted.fetch })
    const r2 = await withNow(async () => (await m2.getAccount(0)).transfer({ recipient: EXISTING, amount: 1_000_000n }))
    const burn2 = BigInt(bandwidthPoints(exhausted.broadcast[0]!.raw_data_hex)) * 1000n
    expect(r2.fee).toBe(burn2)
    expect(r2.estimate!.breakdown.bandwidthBurn).toBe(burn2)
    m2.dispose()

    const staked = fakeNode({}, { resources: { freeNetLimit: 600, freeNetUsed: 600, NetLimit: 5000, NetUsed: 0 } })
    const m3 = new WalletManagerTron(SEED, { provider: staked.fetch })
    const r3 = await withNow(async () => (await m3.getAccount(0)).transfer({ recipient: RECIPIENT, amount: 1_000_000n }))
    // staked bandwidth covers creation bytes → only the 1 TRX system fee
    expect(r3.fee).toBe(1_000_000n)
    expect(r3.estimate!.breakdown).toMatchObject({ bandwidthStaked: 5000, accountCreationFee: 1_000_000n, bandwidthBurn: 0n })
    m3.dispose()
  })

  it('TRC-20 transfer: simulate → build with fee_limit = energy × price × 1.2 → sign → broadcast; burn = unstaked energy × price', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const res = await withNow(() => a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1_000_000n }))
    const sim = f.calls.find((c) => c.path === '/wallet/triggerconstantcontract')!
    expect(sim.body).toMatchObject({ function_selector: 'transfer(address,uint256)', call_value: 0 })
    const build = f.calls.find((c) => c.path === '/wallet/triggersmartcontract')!
    expect(f.paths().indexOf('/wallet/triggerconstantcontract')).toBeLessThan(f.paths().indexOf('/wallet/triggersmartcontract'))
    expect(f.paths().filter((p) => p === '/wallet/triggerconstantcontract')).toHaveLength(1)
    expect(build.body).toMatchObject({ owner_address: a.addressHex, contract_address: toHexAddress(USDT), function_selector: 'transfer(address,uint256)', call_value: 0 })
    expect(build.body.parameter).toBe(encodeParameters([{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 1_000_000n }]))
    expect(selector('transfer(address,uint256)')).toBe('a9059cbb')
    expect(build.body.fee_limit).toBe(Math.ceil(30_000 * 210 * 1.2))
    expect(f.broadcast).toHaveLength(1)
    expect(verifyTx(f.broadcast[0]!, a.publicKey)).toBe(true)
    expect(res.fee).toBe(6_300_000n)
    expect(res.estimate).toMatchObject({ bandwidth: bandwidthPoints(f.broadcast[0]!.raw_data_hex), energy: 30_000, breakdown: { energyBurn: 6_300_000n, bandwidthBurn: 0n, energyStaked: 0 } })
    m.dispose()

    const staked = fakeNode({}, { resources: { freeNetLimit: 600, freeNetUsed: 0, EnergyLimit: 20_000, EnergyUsed: 0 } })
    const m2 = new WalletManagerTron(SEED, { provider: staked.fetch })
    const r2 = await withNow(async () => (await m2.getAccount(0)).transfer({ token: USDT, recipient: RECIPIENT, amount: 1n }))
    expect(r2.fee).toBe(10_000n * 210n)
    m2.dispose()
  })

  it('fee_limit: caller value kept; derived value capped at transactionMaxFee; caller value above the cap is refused', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch, transactionMaxFee: 7_000_000n })
    const a = await m.getAccount(0)
    const call = { contractAddress: USDT, functionSelector: 'approve(address,uint256)', parameters: [{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 7n }] }
    await withNow(() => a.signTransaction({ ...call, options: { feeLimit: 5_000_000 } }))
    expect(f.calls.find((c) => c.path === '/wallet/triggersmartcontract')!.body.fee_limit).toBe(5_000_000)
    await withNow(() => a.signTransaction(call))
    expect(f.calls.filter((c) => c.path === '/wallet/triggersmartcontract')[1]!.body.fee_limit).toBe(7_000_000)
    await expect(withNow(() => a.signTransaction({ ...call, options: { feeLimit: 9_000_000 } }))).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'fee-limit' })
    m.dispose()
  })

  it('memo: raw_data.data adds getMemoFee to the estimate and a memo-fee warning to the description', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const tx = f.rawTx('TransferContract', { owner_address: a.addressHex, to_address: toHexAddress(EXISTING), amount: 1 }, 150, { data: bytesToHex(new TextEncoder().encode('order 42')) })
    const est = await withNow(() => a.estimateFee(tx))
    expect(est.breakdown.memoFee).toBe(1_000_000n)
    expect(est.trxBurn).toBe(1_000_000n)
    const d = describeTransaction(tx, { now: NOW })
    expect(d.memo).toBe('order 42')
    expect(d.warnings.map((w) => w.code)).toEqual(['memo-fee'])
    m.dispose()
  })

  it('simulation: a revert blocks sendTransaction with the decoded reason, nothing is broadcast; simulate:false skips it', async () => {
    const revert = { '/wallet/triggerconstantcontract': (b: Record<string, unknown>) => ({ result: { result: true }, energy_used: 1_210, constant_result: [errorString('Insufficient balance')], transaction: { txID: 'x', raw_data_hex: 'ab', raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: { owner_address: b.owner_address } } }] }, ret: [{ ret: 'FAILED' }] } }) }
    const f = fakeNode(revert)
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const call = { contractAddress: USDT, functionSelector: 'transfer(address,uint256)', parameters: [{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 1n }] }
    expect(await a.simulateTransaction(call)).toMatchObject({ ok: false, energy: 1_210, reason: 'Insufficient balance' })
    const err = await withNow(() => a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1n })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SimulationError)
    expect((err as SimulationError).reason).toBe('Insufficient balance')
    expect(f.broadcast).toHaveLength(0)
    expect(f.paths()).not.toContain('/wallet/broadcasttransaction')
    m.dispose()

    const lax = fakeNode(revert)
    const m2 = new WalletManagerTron(SEED, { provider: lax.fetch, simulate: false })
    await withNow(async () => (await m2.getAccount(0)).transfer({ token: USDT, recipient: RECIPIENT, amount: 1n }))
    expect(lax.broadcast).toHaveLength(1)
    m2.dispose()
  })

  it('simulation: node validation errors (result:false + hex message) and a prebuilt TriggerSmartContract are reported, not thrown', async () => {
    const f = fakeNode({ '/wallet/triggerconstantcontract': () => ({ result: { result: false, code: 'CONTRACT_VALIDATE_ERROR', message: bytesToHex(new TextEncoder().encode('No contract or not a valid smart contract')) } }) })
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const prebuilt = f.rawTx('TriggerSmartContract', { owner_address: a.addressHex, contract_address: toHexAddress(USDT), data: 'a9059cbb' + toHexAddress(EXISTING).slice(2).padStart(64, '0') + '1'.padStart(64, '0') }, 211, { fee_limit: 1 })
    expect(await a.simulateTransaction(prebuilt)).toMatchObject({ ok: false, reason: 'CONTRACT_VALIDATE_ERROR: No contract or not a valid smart contract' })
    await expect(withNow(() => a.sendTransaction(prebuilt))).rejects.toBeInstanceOf(SimulationError)
    m.dispose()
  })

  it('simulation: a TRX transfer the balance cannot cover is refused before signing', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    expect(await a.simulateTransaction({ to: EXISTING, value: 10_000_000n })).toMatchObject({ ok: false, reason: expect.stringMatching(/Insufficient TRX/) })
    expect(await a.simulateTransaction({ to: EXISTING, value: 1_000_000n })).toMatchObject({ ok: true })
    await expect(withNow(() => a.transfer({ recipient: EXISTING, amount: 10_000_000n }))).rejects.toBeInstanceOf(SimulationError)
    expect(f.broadcast).toHaveLength(0)
    m.dispose()
  })

  it('describeTransaction: TRX / TRC-20 / approve / contract-call / freeze / unfreeze / unknown, offline', async () => {
    const trx = describeTransaction({ to: RECIPIENT, value: 5n })
    expect(trx).toMatchObject({ kind: 'trx-transfer', to: RECIPIENT, amount: 5n, warnings: [] })

    const approve = describeTransaction({ contractAddress: USDT, functionSelector: 'approve(address,uint256)', parameters: [{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: (1n << 256n) - 1n }], options: { feeLimit: 10 } })
    expect(approve).toMatchObject({ kind: 'trc20-approve', token: USDT, spender: RECIPIENT, selector: '095ea7b3', feeLimit: 10 })
    expect(approve.warnings.map((w) => w.code)).toEqual(['unlimited-approve'])
    expect(describeTransaction({ contractAddress: USDT, functionSelector: 'approve(address,uint256)', parameters: [{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 1n << 255n }] }).warnings[0]!.code).toBe('unlimited-approve')
    expect(describeTransaction({ contractAddress: USDT, functionSelector: 'approve(address,uint256)', parameters: [{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 1000n }] }).warnings).toEqual([])

    const transfer = describeTransaction({ contractAddress: USDT, functionSelector: 'transfer(address,uint256)', parameters: [{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 7n }] })
    expect(transfer).toMatchObject({ kind: 'trc20-transfer', token: USDT, to: RECIPIENT, amount: 7n, selector: 'a9059cbb' })

    const other = describeTransaction({ contractAddress: USDT, functionSelector: 'burn(uint256)', parameters: [{ type: 'uint256', value: 1n }], options: { callValue: 3 } })
    expect(other).toMatchObject({ kind: 'contract-call', contract: USDT, selector: selector('burn(uint256)'), callValue: 3n })

    const f = fakeNode()
    const owner = toHexAddress(ADDR0)
    const raw = f.rawTx('TriggerSmartContract', { owner_address: owner, contract_address: toHexAddress(USDT), data: 'a9059cbb' + toHexAddress(RECIPIENT).slice(2).padStart(64, '0') + (9n).toString(16).padStart(64, '0') }, 211, { fee_limit: 5 })
    expect(describeTransaction(raw, { now: NOW })).toMatchObject({ kind: 'trc20-transfer', from: ADDR0, token: USDT, to: RECIPIENT, amount: 9n, feeLimit: 5, expiration: NOW + 60_000 })
    const transferFrom = f.rawTx('TriggerSmartContract', { owner_address: owner, contract_address: toHexAddress(USDT), data: '23b872dd' + toHexAddress(EXISTING).slice(2).padStart(64, '0') + toHexAddress(RECIPIENT).slice(2).padStart(64, '0') + (2n).toString(16).padStart(64, '0') }, 211)
    expect(describeTransaction(transferFrom, { now: NOW })).toMatchObject({ kind: 'contract-call', selector: '23b872dd', from: EXISTING, to: RECIPIENT, amount: 2n, token: USDT })
    expect(describeTransaction(f.rawTx('FreezeBalanceV2Contract', { owner_address: owner, frozen_balance: 1_000_000, resource: 'ENERGY' }, 100), { now: NOW })).toMatchObject({ kind: 'freeze', amount: 1_000_000n, resource: 'ENERGY', from: ADDR0 })
    expect(describeTransaction(f.rawTx('UnfreezeBalanceV2Contract', { owner_address: owner, unfreeze_balance: 5, resource: 'BANDWIDTH' }, 100), { now: NOW })).toMatchObject({ kind: 'unfreeze', amount: 5n, resource: 'BANDWIDTH' })
    expect(describeTransaction(f.rawTx('VoteWitnessContract', { owner_address: owner }, 100), { now: NOW }).kind).toBe('unknown')
    // visible:true raw transactions carry base58 addresses
    const visible = f.rawTx('TransferContract', { owner_address: ADDR0, to_address: RECIPIENT, amount: '12' }, 134)
    expect(describeTransaction({ ...visible, visible: true }, { now: NOW })).toMatchObject({ kind: 'trx-transfer', from: ADDR0, to: RECIPIENT, amount: 12n })
  })

  it('describeTransaction warnings: zero-address, expired, unactivated-recipient (ctx or online)', async () => {
    expect(describeTransaction({ to: ZERO_ADDRESS, value: 1n }).warnings.map((w) => w.code)).toEqual(['zero-address'])
    expect(describeTransaction({ contractAddress: USDT, functionSelector: 'transfer(address,uint256)', parameters: [{ type: 'address', value: ZERO_ADDRESS }, { type: 'uint256', value: 1n }] }).warnings.map((w) => w.code)).toEqual(['zero-address'])
    const f = fakeNode()
    const stale = f.rawTx('TransferContract', { owner_address: toHexAddress(ADDR0), to_address: toHexAddress(EXISTING), amount: 1 }, 134, { expiration: NOW - 1 })
    expect(describeTransaction(stale, { now: NOW }).warnings.map((w) => w.code)).toEqual(['expired'])
    expect(describeTransaction({ to: RECIPIENT, value: 1n }, { recipientExists: false }).warnings.map((w) => w.code)).toEqual(['unactivated-recipient'])
    expect(describeTransaction({ to: RECIPIENT, value: 1n }, { recipientExists: true }).warnings).toEqual([])

    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    expect((await a.describeTransactionOnline({ to: RECIPIENT, value: 1n })).warnings.map((w) => w.code)).toEqual(['unactivated-recipient'])
    expect((await a.describeTransactionOnline({ to: EXISTING, value: 1n })).warnings).toEqual([])
    expect((await a.describeTransactionOnline({ contractAddress: USDT, functionSelector: 'transfer(address,uint256)', parameters: [{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 1n }] })).warnings[0]!.code).toBe('unactivated-recipient')
    expect(f.paths()).toEqual(['/wallet/getaccount', '/wallet/getaccount', '/wallet/getaccount'])
    m.dispose()
  })

  it('hard checks refuse: expired / too-far expiration, missing ref block, multi-contract, foreign owner, zero-address burn (unless allowBurn)', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const base = (extra: Record<string, unknown>, value: Record<string, unknown> = { owner_address: a.addressHex, to_address: toHexAddress(EXISTING), amount: 1 }) =>
      f.rawTx('TransferContract', value, 134, extra)
    const code = async (tx: TronRawTransaction) => withNow(() => a.signTransaction(tx)).then(() => 'ok', (e: unknown) => (e as UnsafeTransactionError).code ?? (e as Error).message)
    expect(await code(base({ expiration: NOW - 1 }))).toBe('expired')
    expect(await code(base({ expiration: undefined }))).toBe('expired')
    expect(await code(base({ expiration: NOW + 25 * 3_600_000 }))).toBe('expiration-too-far')
    expect(await code(base({ ref_block_bytes: undefined }))).toBe('missing-ref-block')
    expect(await code(base({ ref_block_hash: undefined }))).toBe('missing-ref-block')
    expect(await code(base({}, { owner_address: toHexAddress(RECIPIENT), to_address: toHexAddress(EXISTING), amount: 1 }))).toBe('owner-mismatch')
    const two = base({})
    two.raw_data.contract.push(two.raw_data.contract[0]!)
    expect(await code(two)).toBe('raw-mismatch') // the JSON grew a contract the bytes do not carry
    expect(await code(seal(two.raw_data))).toBe('multi-contract')
    expect(await code(base({}, { owner_address: a.addressHex, to_address: toHexAddress(ZERO_ADDRESS), amount: 1 }))).toBe('zero-address')
    expect(await code(base({}))).toBe('ok')
    expect(f.broadcast).toHaveLength(0)
    await expect(withNow(() => a.transfer({ recipient: ZERO_ADDRESS, amount: 1n }))).rejects.toMatchObject({ code: 'zero-address' })
    await expect(withNow(() => a.transfer({ token: USDT, recipient: ZERO_ADDRESS, amount: 1n }))).rejects.toMatchObject({ code: 'zero-address' })
    // the owner check message is preserved for callers matching on it
    await expect(withNow(() => a.sendTransaction(base({}, { owner_address: toHexAddress(RECIPIENT) })))).rejects.toThrow(/owner/)
    m.dispose()

    const burn = fakeNode()
    const m2 = new WalletManagerTron(SEED, { provider: burn.fetch, allowBurn: true })
    await withNow(async () => (await m2.getAccount(0)).transfer({ recipient: ZERO_ADDRESS, amount: 1n }))
    expect(burn.broadcast).toHaveLength(1)
    m2.dispose()
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
    await expect(withNow(() => a.transfer({ recipient: RECIPIENT, amount: 1n }))).rejects.toThrow(/maximum fee/)
    await expect(withNow(() => a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1n }))).rejects.toThrow(/maximum fee/)
    await expect(withNow(() => a.sendTransaction({ to: RECIPIENT, value: 1n }))).rejects.toThrow(/maximum fee/)
    await expect(withNow(() => a.signTransaction({ to: RECIPIENT, value: 1n }))).rejects.toThrow(/maximum fee/)
    expect(f.broadcast).toHaveLength(0)
    m.dispose()
  })

  it('signTransaction returns broadcast-ready JSON that sendTransaction re-broadcasts without re-signing', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const signed = await withNow(() => a.signTransaction({ contractAddress: USDT, functionSelector: 'approve(address,uint256)', parameters: [{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 7n }] }))
    const parsed = JSON.parse(signed) as TronRawTransaction
    expect(parsed.signature).toHaveLength(1)
    const res = await withNow(() => a.sendTransaction(signed))
    expect(res.hash).toBe(parsed.txID)
    expect(f.broadcast[0]!.signature).toEqual(parsed.signature)
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

  it('scan F7: a malicious node build (other recipient, approve instead of transfer, account takeover) is refused before signing; nothing is broadcast', async () => {
    let f: ReturnType<typeof fakeNode>
    const evilCall = fakeNode({
      '/wallet/triggersmartcontract': (b) => ({ result: { result: true }, transaction: f.rawTx('TriggerSmartContract', { owner_address: b.owner_address, contract_address: b.contract_address, data: selector('transfer(address,uint256)') + encodeParameters([{ type: 'address', value: RECIPIENT }, { type: 'uint256', value: 1n }]) }, 211, { fee_limit: b.fee_limit }) }),
    })
    f = evilCall
    const m = new WalletManagerTron(SEED, { provider: evilCall.fetch })
    const a = await m.getAccount(0)
    await expect(withNow(() => a.transfer({ token: USDT, recipient: EXISTING, amount: 1n }))).rejects.toMatchObject({ code: 'build-mismatch' })
    await expect(withNow(() => a.quoteTransfer({ token: USDT, recipient: EXISTING, amount: 1n }))).rejects.toMatchObject({ code: 'build-mismatch' })
    // the honest call through the same node (it lies only about EXISTING) still goes through
    await expect(withNow(() => a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1n }))).resolves.toMatchObject({ hash: expect.any(String) })
    expect(evilCall.broadcast).toHaveLength(1)
    m.dispose()

    const evilTrx = fakeNode({
      '/wallet/createtransaction': (b) => f.rawTx('AccountPermissionUpdateContract', { owner_address: b.owner_address, raw_parameter_hex: '0a15' + String(b.owner_address) + '12050a03666f6f' }, 134),
    })
    f = evilTrx
    const m2 = new WalletManagerTron(SEED, { provider: evilTrx.fetch })
    await expect(withNow(async () => (await m2.getAccount(0)).transfer({ recipient: EXISTING, amount: 1n }))).rejects.toMatchObject({ code: 'build-mismatch' })
    expect(evilTrx.broadcast).toHaveLength(0)
    m2.dispose()
  })

  it('a hex memo (Chainflip vault-swap note) is spliced as raw bytes and checked against the build', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    await withNow(() => a.transfer({ token: USDT, recipient: EXISTING, amount: 1n, memo: '0x00a1ff', memoEncoding: 'hex' }))
    expect(f.broadcast[0]!.raw_data.data).toBe('00a1ff')
    expect(decodeRawData(f.broadcast[0]!.raw_data_hex).raw_data.data).toBe('00a1ff')
    m.dispose()
  })

  it('offline wallet refuses network ops; read-only cannot sign; dispose kills signing', async () => {
    const m = new WalletManagerTron(SEED)
    const a = await m.getAccount(0)
    await expect(a.getBalance()).rejects.toThrow(/provider/)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/provider/)
    await expect(a.estimateFee({ to: RECIPIENT, value: 1n })).rejects.toThrow(/provider/)
    await expect(a.simulateTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(/provider/)
    const ro = a.toReadOnlyAccount() as unknown as Record<string, unknown>
    expect(ro.sign).toBeUndefined()
    expect(ro.sendTransaction).toBeUndefined()
    m.dispose()
    await expect(a.sign('x')).rejects.toThrow(/disposed/)
  })
})
