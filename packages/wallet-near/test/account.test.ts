import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { base58 } from '@scure/base'
import {
  NearRpcError, SimulationError, UnsafeTransactionError, WalletManagerNear, decodeSignedTransaction, describeTransaction, fromBase64, type NearFetch,
} from '../src/index.js'
import { ACCOUNT0, BLOCK, NEAR, SEED, USDT, fakeNode } from './fake-node.js'

const ACCOUNT1 = '3b93b03253b9715213ec314eb50ecc99d25602ccb5b059f91f51d24710d54326'

const manager = (f: { fetch: NearFetch }, extra = {}) => new WalletManagerNear(SEED, { provider: f.fetch, ...extra })

describe('WalletAccountNear', () => {
  it('derives the NEAR Wallet account (implicit id = hex of the ed25519 key) and signs messages the node can verify', async () => {
    const m = manager(fakeNode())
    const a = await m.getAccount(0)
    expect(a.address).toBe(ACCOUNT0)
    expect(a.chain).toBe('near:mainnet')
    expect(a.index).toBe(0)
    expect((await m.getAccount(1)).address).toBe(ACCOUNT1)
    const sig = await a.sign('hello')
    expect(sig.startsWith('ed25519:')).toBe(true)
    expect(await a.verify('hello', sig)).toBe(true)
    expect(await a.verify('hellp', sig)).toBe(false)
    expect(ed25519.verify(base58.decode(sig.slice(8)), new TextEncoder().encode('hello'), a.publicKey.data)).toBe(true)
    const nep = await a.signNep413({ message: 'login', nonce: new Uint8Array(32), recipient: 'intents.near' })
    expect(nep.accountId).toBe(ACCOUNT0)
    expect(nep.publicKey).toBe(a.publicKeyString)
    expect(fromBase64(nep.signature)).toHaveLength(64)
    await expect(m.getAccountByPath("m/44'/397'/0'/0")).rejects.toThrow(/hardened/)
    m.dispose()
  })

  it('native transfer: builds nonce+1 / final block hash, checks, preflights, signs and broadcasts', async () => {
    const f = fakeNode()
    const a = await manager(f).getAccount(0)
    const res = await a.transfer({ recipient: 'alice.near', amount: NEAR })
    expect(res.hash).toBe('HASH42')
    expect(res.fee).toBeGreaterThan(0n)
    expect(res.fee).toBeLessThan(10n ** 21n) // well under 0.001 NEAR
    const tx = decodeSignedTransaction(fromBase64(f.sent[0]!)).transaction
    expect(tx.signerId).toBe(ACCOUNT0)
    expect(tx.nonce).toBe(42n)
    expect(base58.encode(tx.blockHash)).toBe(BLOCK)
    expect(tx.receiverId).toBe('alice.near')
    expect(tx.actions).toEqual([{ transfer: { deposit: NEAR } }])
    expect(describeTransaction(tx).kind).toBe('near-transfer')
    expect((await a.getTransactionReceipt(res.hash))?.status).toBe(1)
  })

  it('NEP-141 transfer registers an unregistered recipient first (storage_deposit + ft_transfer in one tx)', async () => {
    const f = fakeNode()
    const a = await manager(f).getAccount(0)
    await a.transfer({ token: USDT, recipient: 'alice.near', amount: 1_500_000n, memo: 'hi' })
    const tx = decodeSignedTransaction(fromBase64(f.sent[0]!)).transaction
    expect(tx.receiverId).toBe(USDT)
    const d = describeTransaction(tx, { signerId: ACCOUNT0 })
    expect(d.kind).toBe('ft-transfer')
    expect(d.methods).toEqual(['storage_deposit', 'ft_transfer'])
    expect(d.to).toBe('alice.near')
    expect(d.amount).toBe(1_500_000n)
    expect(d.token).toBe(USDT)
    expect(d.memo).toBe('hi')
    expect(d.deposit).toBe(1_250_000_000_000_000_000_000n + 1n)
    // registered recipient → no storage_deposit
    const g = fakeNode({ registered: [ACCOUNT0, 'alice.near'] })
    const b = await manager(g).getAccount(0)
    await b.transfer({ token: USDT, recipient: 'alice.near', amount: 1n })
    expect(describeTransaction(decodeSignedTransaction(fromBase64(g.sent[0]!)).transaction).methods).toEqual(['ft_transfer'])
  })

  it('caps the storage_deposit a token contract asks for, and refuses a malformed one (audit F12)', async () => {
    const greedy = fakeNode({ storageMin: String(4n * NEAR) })
    await expect((await manager(greedy).getAccount(0)).transfer({ token: USDT, recipient: 'alice.near', amount: 1n })).rejects.toMatchObject({ code: 'storage-deposit' })
    expect(greedy.sent).toHaveLength(0)
    const odd = fakeNode({ storageMin: 1e30 })
    await expect((await manager(odd).getAccount(0)).transfer({ token: USDT, recipient: 'alice.near', amount: 1n })).rejects.toMatchObject({ code: 'storage-deposit' })
    // a host can raise the cap deliberately
    const raised = fakeNode({ storageMin: String(4n * NEAR) })
    await (await manager(raised, { maxStorageDeposit: 5n * NEAR }).getAccount(0)).transfer({ token: USDT, recipient: 'alice.near', amount: 1n })
    expect(raised.sent).toHaveLength(1)
  })

  it('preflight refuses: unknown named recipient, implicit account below 0.002 NEAR, insufficient NEAR, insufficient token', async () => {
    const a = await manager(fakeNode()).getAccount(0)
    await expect(a.transfer({ recipient: 'nobody.near', amount: NEAR })).rejects.toThrow(SimulationError)
    await expect(a.transfer({ recipient: ACCOUNT1, amount: 10n ** 20n })).rejects.toThrow(/0\.002 NEAR/)
    await expect(a.transfer({ recipient: ACCOUNT1, amount: NEAR / 100n })).resolves.toBeTruthy() // implicit account creation is fine
    await expect(a.transfer({ recipient: 'alice.near', amount: 100n * NEAR })).rejects.toThrow(/Insufficient NEAR/)
    await expect(a.transfer({ token: USDT, recipient: 'alice.near', amount: 10_000_001n })).rejects.toThrow(/Insufficient usdt/)
    await expect(a.transfer({ recipient: 'Not Valid!', amount: 1n })).rejects.toThrow(UnsafeTransactionError)
    const q = await a.quoteTransfer({ recipient: ACCOUNT1, amount: NEAR })
    expect(q.estimate.createsAccount).toBe(true)
    expect(q.fee).toBeGreaterThan((await a.quoteTransfer({ recipient: 'alice.near', amount: NEAR })).fee)
  })

  it('hard checks refuse dangerous actions, foreign signers, >300 Tgas and fee caps before anything is signed', async () => {
    const f = fakeNode()
    const a = await manager(f).getAccount(0)
    const pk = a.publicKey
    await expect(a.sendTransaction({ receiverId: ACCOUNT0, actions: [{ addKey: { publicKey: pk, accessKey: { nonce: 0n, permission: { fullAccess: {} } } } }] })).rejects.toMatchObject({ code: 'dangerous-action' })
    await expect(a.sendTransaction({ receiverId: ACCOUNT0, actions: [{ deleteAccount: { beneficiaryId: 'alice.near' } }] })).rejects.toMatchObject({ code: 'dangerous-action' })
    await expect(a.sendTransaction({ receiverId: 'alice.near', signerId: 'alice.near', actions: [{ transfer: { deposit: 1n } }] })).rejects.toMatchObject({ code: 'signer-mismatch' })
    await expect(a.sendTransaction({ receiverId: 'alice.near', actions: [] })).rejects.toMatchObject({ code: 'no-actions' })
    await expect(a.sendTransaction({ receiverId: USDT, actions: [{ functionCall: { methodName: 'ft_transfer', args: {}, gas: 301n * 10n ** 12n, deposit: 1n } }] })).rejects.toMatchObject({ code: 'gas-limit' })
    expect(f.sent).toHaveLength(0)
    const capped = await manager(f, { transferMaxFee: 1n }).getAccount(0)
    await expect(capped.transfer({ recipient: 'alice.near', amount: 1n })).rejects.toThrow(/maximum fee/)
    // allowed when the owner opts in
    const loose = await manager(f, { allowDangerousActions: true }).getAccount(0)
    await expect(loose.sendTransaction({ receiverId: ACCOUNT0, actions: [{ deleteKey: { publicKey: pk } }] })).resolves.toBeTruthy()
  })

  it('a presigned base64 transaction is checked, not re-signed; an on-chain failure surfaces as an error', async () => {
    const f = fakeNode()
    const a = await manager(f).getAccount(0)
    const signed = await a.signTransaction({ receiverId: 'alice.near', actions: [{ transfer: { deposit: 1n } }] })
    const res = await a.sendTransaction(signed)
    expect(f.sent[0]).toBe(signed)
    expect(res.hash).toBe('HASH42')
    // tampered: someone else's signer id inside a signed blob
    const other = decodeSignedTransaction(fromBase64(signed))
    other.transaction.signerId = 'alice.near'
    const { encodeSignedTransaction, toBase64 } = await import('../src/index.js')
    await expect(a.sendTransaction(toBase64(encodeSignedTransaction(other)))).rejects.toMatchObject({ code: 'signer-mismatch' })
    const failing = await manager(fakeNode({ failOnChain: 'Smart contract panicked: The account is not registered' })).getAccount(0)
    await expect(failing.transfer({ recipient: 'alice.near', amount: 1n })).rejects.toThrow(/not registered/)
  })

  it('offline manager: derive + sign work, anything needing the node throws', async () => {
    const m = new WalletManagerNear(SEED)
    const a = await m.getAccount(0)
    expect(a.needsNetwork).toBe(true)
    expect(await a.sign('x')).toMatch(/^ed25519:/)
    await expect(a.getBalance()).rejects.toThrow(/provider/)
    await expect(a.transfer({ recipient: 'alice.near', amount: 1n })).rejects.toThrow(/provider/)
    expect(await m.getFeeRates().catch((e: Error) => e.message)).toMatch(/provider/)
    m.dispose()
    await expect(a.sign('x')).rejects.toThrow()
  })
})
