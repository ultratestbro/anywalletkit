import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { getBase64Encoder, getTransactionDecoder, getCompiledTransactionMessageDecoder, type Address } from '@solana/kit'
import { WalletManagerSolana, type SolanaRpc } from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' // golden vector, account 0
const RECIPIENT = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb' // account 1
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'

/** Fake @solana/kit Rpc: each method returns { send } like the real one, and records calls. */
function fakeRpc(overrides: Record<string, (...a: unknown[]) => unknown> = {}) {
  const sent: string[] = []
  const calls: string[] = []
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getFeeForMessage: () => ({ value: 5000n }),
    getBalance: () => ({ value: 1_000_000_000n }),
    getAccountInfo: () => ({ value: null }), // recipient ATA missing by default
    sendTransaction: (wire) => { sent.push(wire as string); return 'A'.repeat(87) },
    getRecentPrioritizationFees: () => [{ prioritizationFee: 0 }, { prioritizationFee: 7000 }],
    ...overrides,
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { calls.push(m); const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, sent, calls }
}

function decodeWire(wire: string) {
  const bytes = getBase64Encoder().encode(wire)
  const tx = getTransactionDecoder().decode(bytes)
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as { instructions: unknown[]; staticAccounts: Address[] }
  return { tx, msg }
}

describe('WalletAccountSolana', () => {
  it('derives account 0 and accepts relative paths', async () => {
    const m = new WalletManagerSolana(SEED)
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(ADDR0)
    expect(a.index).toBe(0)
    expect(a.chain).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
    expect(await m.getAccountByPath("0'/0'")).toBe(a)
    await expect(m.getAccountByPath("0'/0")).rejects.toThrow(/hardened/)
    m.dispose()
  })

  it('sign returns hex ed25519 over utf8 and verify agrees', async () => {
    const m = new WalletManagerSolana(SEED)
    const a = await m.getAccount(0)
    const sig = await a.sign('hi')
    expect(sig).toMatch(/^[0-9a-f]{128}$/)
    expect(await a.verify('hi', sig)).toBe(true)
    expect(await a.verify('ho', sig)).toBe(false)
    m.dispose()
  })

  it('native transfer: fee payer = account, 1 instruction, valid signature, fee from getFeeForMessage', async () => {
    const f = fakeRpc()
    const m = new WalletManagerSolana(SEED, { provider: f.rpc })
    const a = await m.getAccount(0)
    const res = await a.transfer({ recipient: RECIPIENT, amount: 1_000n })
    expect(res.fee).toBe(5000n)
    expect(res.hash).toBe('A'.repeat(87))
    const { tx, msg } = decodeWire(f.sent[0]!)
    expect(msg.instructions).toHaveLength(1)
    expect(msg.staticAccounts[0]).toBe(ADDR0 as Address)
    const sig = tx.signatures[ADDR0 as Address]!
    expect(ed25519.verify(sig as unknown as Uint8Array, tx.messageBytes as unknown as Uint8Array, a.publicKey)).toBe(true)
    m.dispose()
  })

  it('SPL transfer adds create-ATA when the recipient ATA is missing, and skips it when present', async () => {
    const missing = fakeRpc()
    const m = new WalletManagerSolana(SEED, { provider: missing.rpc })
    await (await m.getAccount(0)).transfer({ token: USDC, recipient: RECIPIENT, amount: 1n })
    expect(decodeWire(missing.sent[0]!).msg.instructions).toHaveLength(2)

    const present = fakeRpc({ getAccountInfo: () => ({ value: { data: ['', 'base64'], owner: USDC } }) })
    const m2 = new WalletManagerSolana(SEED, { provider: present.rpc })
    await (await m2.getAccount(0)).transfer({ token: USDC, recipient: RECIPIENT, amount: 1n })
    expect(decodeWire(present.sent[0]!).msg.instructions).toHaveLength(1)
    m.dispose(); m2.dispose()
  })

  it('transferMaxFee / transactionMaxFee stop before broadcast', async () => {
    const f = fakeRpc()
    const m = new WalletManagerSolana(SEED, { provider: f.rpc, transferMaxFee: 1n, transactionMaxFee: 1n })
    const a = await m.getAccount(0)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/maximum fee/)
    await expect(a.sendTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(/maximum fee/)
    expect(f.sent).toHaveLength(0)
    m.dispose()
  })

  it('signTransaction({to, value}) returns a base64 wire tx that sendTransaction re-broadcasts without re-signing', async () => {
    const f = fakeRpc()
    const m = new WalletManagerSolana(SEED, { provider: f.rpc })
    const a = await m.getAccount(0)
    const wire = await a.signTransaction({ to: RECIPIENT, value: 10n })
    const { tx } = decodeWire(wire)
    const res = await a.sendTransaction(tx)
    expect(res.fee).toBe(5000n)
    expect(f.sent[0]).toBe(wire)
    m.dispose()
  })

  it('failover rpc walks the list', async () => {
    const dead = fakeRpc({ getBalance: () => { throw new Error('boom') } })
    const alive = fakeRpc()
    const m = new WalletManagerSolana(SEED, { provider: [dead.rpc, alive.rpc] })
    expect(await (await m.getAccount(0)).getBalance()).toBe(1_000_000_000n)
    expect(dead.calls).toEqual(['getBalance'])
    expect(alive.calls).toEqual(['getBalance'])
    m.dispose()
  })

  it('getFeeRates uses the max non-zero prioritization fee', async () => {
    const f = fakeRpc()
    const m = new WalletManagerSolana(SEED, { provider: f.rpc })
    expect(await m.getFeeRates()).toEqual({ slow: 5600n, normal: 7000n, fast: 8400n })
    m.dispose()
  })

  it('offline wallet refuses network operations with a clear error, and read-only cannot sign', async () => {
    const m = new WalletManagerSolana(SEED)
    const a = await m.getAccount(0)
    await expect(a.getBalance()).rejects.toThrow(/provider/)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/provider/)
    expect((a.toReadOnlyAccount() as unknown as Record<string, unknown>).sign).toBeUndefined()
    m.dispose()
    await expect(a.sign('x')).rejects.toThrow(/disposed/)
  })
})
