/**
 * The simulation path with a mock RPC that answers the way real RPCs do: `getMultipleAccounts` for lookup tables
 * (base64 account data), `simulateTransaction` with pre/post balances, `loadedAddresses` (sometimes empty lists even
 * for v0) and inner instructions in jsonParsed form (`parsed` for programs the RPC knows, `{programId, accounts, data}`
 * base58 otherwise). Replies are rebuilt from confirmed fixtures, so the expected balances are known.
 */
import { appendTransactionMessageInstruction, createNoopSigner, createTransactionMessage, getAddressDecoder, getBase64Decoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address, type Blockhash } from '@solana/kit'
import { getAddressLookupTableEncoder } from '@solana-program/address-lookup-table'
import { getTransferSolInstruction } from '@solana-program/system'
import { describe, expect, it, vi } from 'vitest'
import { ADDRESS_LOOKUP_TABLE_PROGRAM, describeTransaction, fetchLookupTables, type PreviewRpc } from '../src/index.js'
import { fixtureBalanceChanges, loadFixture, type Fixture } from './helpers.js'

const b64 = getBase64Decoder()
const FILLER = 'Fi11er1111111111111111111111111111111111111' as Address

/** A lookup table account as the RPC returns it (base64), entries the fixture does not know filled in. */
function tableAccount(entries: readonly (string | null)[], owner = ADDRESS_LOOKUP_TABLE_PROGRAM) {
  const data = getAddressLookupTableEncoder().encode({
    deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 1n, lastExtendedSlotStartIndex: 0, authority: null,
    addresses: Array.from({ length: entries.length }, (_, i) => (entries[i] ?? FILLER) as Address),
  })
  return { owner, data: [b64.decode(data), 'base64'], lamports: 1n, executable: false, rentEpoch: 0n, space: BigInt(data.length) }
}

interface MockOptions {
  tables?: Record<string, ReturnType<typeof tableAccount> | null>
  value?: Record<string, unknown>
  fail?: Error
}

/** A kit-shaped RPC: every method returns `{ send }`; calls are recorded. */
function mockRpc(o: MockOptions) {
  const calls: Array<{ method: string; args: unknown[]; send?: unknown }> = []
  const method = (name: string, reply: (...args: unknown[]) => unknown) => (...args: unknown[]) => ({
    send: async (sendOptions?: unknown) => {
      calls.push({ method: name, args, send: sendOptions })
      if (o.fail) throw o.fail
      return reply(...args)
    },
  })
  const rpc = {
    getMultipleAccounts: method('getMultipleAccounts', (addresses) => ({ context: { slot: 1n }, value: (addresses as string[]).map((a) => o.tables?.[a] ?? null) })),
    simulateTransaction: method('simulateTransaction', () => ({ context: { slot: 1n }, value: o.value })),
  }
  return { rpc: rpc as unknown as PreviewRpc, calls }
}

/** What simulateTransaction answers for a transaction that does what the fixture did. */
function replyFrom(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    err: f.meta.err, logs: f.meta.logMessages, unitsConsumed: 12_345n, fee: BigInt(f.meta.fee), accounts: null, returnData: null,
    preBalances: f.meta.preBalances.map(BigInt), postBalances: f.meta.postBalances.map(BigInt),
    preTokenBalances: f.meta.preTokenBalances, postTokenBalances: f.meta.postTokenBalances,
    loadedAddresses: f.meta.loadedAddresses, innerInstructions: f.meta.innerInstructions,
    ...overrides,
  }
}

const tablesOf = (f: Fixture) => Object.fromEntries(Object.entries(f.lookupTables).map(([k, v]) => [k, tableAccount(v)]))

describe('describeTransaction with an RPC', () => {
  it('v0: reads the lookup tables, simulates, and reports balances + inner instructions as the confirmed transaction had them', async () => {
    const f = loadFixture('token/unwrap-lamports.json')
    const { rpc, calls } = mockRpc({ tables: tablesOf(f), value: replyFrom(f) })
    const p = await describeTransaction(f.wire, { rpc })
    expect(calls.map((c) => c.method)).toEqual(['getMultipleAccounts', 'simulateTransaction'])
    expect(p.lookupTables.every((t) => t.resolved)).toBe(true)
    expect(p.warnings.map((w) => w.code)).not.toContain('unresolved-lookup-tables')
    expect(p.simulation).toMatchObject({ ok: true, error: null, unitsConsumed: 12_345n, fee: 5_000n })
    expect(p.simulation!.logs).toEqual(f.meta.logMessages)
    expect(p.simulation!.balances).toEqual(fixtureBalanceChanges(f))
    // The swap's inner instructions: the RPC parsed the token ones (shown as its reading), the AMM one stays raw.
    const inner = p.simulation!.innerInstructions
    expect(inner.map((g) => g.index)).toEqual([2])
    const ixs = inner[0]!.instructions
    expect(ixs[0]).toMatchObject({ parsedByRpc: true, name: 'CreateIdempotent', programName: 'Associated Token Account Program', decoded: true })
    expect(ixs.filter((i) => i.parsedByRpc).map((i) => i.name)).toContain('TransferChecked')
    const raw = ixs.filter((i) => !i.parsedByRpc)
    expect(raw.length).toBe(2)
    for (const r of raw) {
      expect(r.decoded).toBe(false)
      expect(r.accounts.length).toBeGreaterThan(0)
      expect(r.data.length).toBeGreaterThan(0)
    }
    // An account named in a raw inner instruction keeps the role it has in the message.
    const signer = p.feePayer!
    for (const r of raw) for (const a of r.accounts.filter((x) => x.address === signer)) expect(a).toMatchObject({ signer: true, writable: true })
  })

  it('sends the transaction unsigned-safe: sigVerify off, blockhash replaced, inner instructions on, base64', async () => {
    const f = loadFixture('token-2022/transfer.json')
    const { rpc, calls } = mockRpc({ value: replyFrom(f) })
    const controller = new AbortController()
    await describeTransaction(f.wire, { rpc, commitment: 'processed', abortSignal: controller.signal })
    const sim = calls.find((c) => c.method === 'simulateTransaction')!
    expect(sim.args[0]).toBe(f.wire)
    expect(sim.args[1]).toMatchObject({ encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, commitment: 'processed' })
    expect(sim.send).toEqual({ abortSignal: controller.signal })
  })

  it('loadedAddresses as empty lists (some RPCs answer that for v0): falls back to the tables it resolved', async () => {
    const f = loadFixture('token/unwrap-lamports.json')
    const { rpc } = mockRpc({ tables: tablesOf(f), value: replyFrom(f, { loadedAddresses: { writable: [], readonly: [] } }) })
    const p = await describeTransaction(f.wire, { rpc })
    expect(p.simulation!.balances).toEqual(fixtureBalanceChanges(f))
  })

  it('loadedAddresses missing and the tables unreadable: lookup accounts stay unknown, the signer\'s own view is still right', async () => {
    const f = loadFixture('token/unwrap-lamports.json')
    const { rpc } = mockRpc({ tables: {}, value: replyFrom(f, { loadedAddresses: null }) })
    const p = await describeTransaction(f.wire, { rpc })
    expect(p.warnings.map((w) => w.code)).toContain('unresolved-lookup-tables')
    const want = fixtureBalanceChanges(f)!
    // The signer's wSOL account is a static key; the pool's accounts (in the tables) drop out instead of being mis-named.
    expect(p.simulation!.balances!.signer).toEqual(want.signer)
    expect(p.simulation!.balances!.sol.length).toBeLessThan(want.sol.length)
    expect(p.simulation!.balances!.sol.every((s) => typeof s.account === 'string')).toBe(true)
  })

  it('the RPC\'s loadedAddresses win when they account for every lookup entry (the RPC resolved them itself)', async () => {
    const f = loadFixture('messages/v0-lookup-tables.json')
    // Tables not readable, but the simulation reports what it loaded.
    const { rpc } = mockRpc({ tables: {}, value: replyFrom(f) })
    const p = await describeTransaction(f.wire, { rpc })
    expect(p.simulation!.balances).toEqual(fixtureBalanceChanges(f))
  })

  it('a failed simulation is reported, not thrown', async () => {
    const f = loadFixture('token/transfer.json')
    const err = { InstructionError: [0, { Custom: 1 }] }
    const { rpc } = mockRpc({ value: replyFrom(f, { err, postBalances: f.meta.preBalances.map(BigInt) }) })
    const p = await describeTransaction(f.wire, { rpc })
    expect(p.simulation).toMatchObject({ ok: false, error: { InstructionError: [0, { Custom: 1 }] } })
    expect(p.warnings.find((w) => w.code === 'simulation-failed')!.message).toContain('"Custom":1')
  })

  it('no pre/post balances in the reply: balances null and the warning', async () => {
    const f = loadFixture('token/transfer.json')
    const { rpc } = mockRpc({ value: replyFrom(f, { preBalances: undefined, postBalances: undefined, fee: undefined, unitsConsumed: undefined }) })
    const p = await describeTransaction(f.wire, { rpc })
    expect(p.simulation).toMatchObject({ ok: true, balances: null, fee: null, unitsConsumed: null })
    expect(p.warnings.map((w) => w.code)).toContain('balances-unavailable')
  })

  it('inner instructions in the compiled form (programIdIndex + account indices) decode through the registry', async () => {
    const f = loadFixture('token-2022/transfer.json')
    const keys = (f as Fixture & { accountKeys: Array<{ pubkey: string }> }).accountKeys.map((k) => k.pubkey)
    // CreateIdempotent's inner System CreateAccount, as an older RPC would send it.
    const createAccount = (f.meta.innerInstructions as Array<{ instructions: Array<{ parsed?: { type: string; info: Record<string, string> } }> }>)[0]!.instructions[1]!.parsed!.info
    const data = new Uint8Array(52)
    new DataView(data.buffer).setUint32(0, 0, true)
    new DataView(data.buffer).setBigUint64(4, BigInt(createAccount.lamports!), true)
    new DataView(data.buffer).setBigUint64(12, BigInt(createAccount.space!), true)
    data.set(new Uint8Array(32).fill(0), 20)
    const { getBase58Decoder } = await import('@solana/kit')
    const compiled = { programIdIndex: keys.indexOf('11111111111111111111111111111111'), accounts: [keys.indexOf(createAccount.source!), keys.indexOf(createAccount.newAccount!)], data: getBase58Decoder().decode(data) }
    const { rpc } = mockRpc({ value: replyFrom(f, { innerInstructions: [{ index: 2, instructions: [compiled] }] }) })
    const p = await describeTransaction(f.wire, { rpc })
    const ix = p.simulation!.innerInstructions[0]!.instructions[0]!
    expect(ix).toMatchObject({ programName: 'System Program', name: 'CreateAccount', decoded: true, args: { lamports: 2_074_080n, space: 170n } })
    expect(ix.accounts.map((a) => [a.name, a.address])).toEqual([['payer', createAccount.source], ['newAccount', createAccount.newAccount]])
    expect(ix.parsedByRpc).toBeUndefined()
  })

  it('a raw inner instruction with bad base58 data is kept, not thrown', async () => {
    const f = loadFixture('token-2022/transfer.json')
    const { rpc } = mockRpc({ value: replyFrom(f, { innerInstructions: [{ index: 0, instructions: [{ programId: 'Prog1111111111111111111111111111111111111111', accounts: [], data: '0OIl' }] }] }) })
    const p = await describeTransaction(f.wire, { rpc })
    expect(p.simulation!.innerInstructions[0]!.instructions[0]).toMatchObject({ decoded: false, data: '', programAddress: 'Prog1111111111111111111111111111111111111111' })
  })

  it('a transport error throws (it is not a simulation result)', async () => {
    const f = loadFixture('token/transfer.json')
    const { rpc } = mockRpc({ fail: new Error('503 Service Unavailable') })
    await expect(describeTransaction(f.wire, { rpc })).rejects.toThrow('503')
  })

  it('simulate: false decodes only (tables still read through the RPC)', async () => {
    const f = loadFixture('messages/v0-lookup-tables.json')
    const { rpc, calls } = mockRpc({ tables: tablesOf(f) })
    const p = await describeTransaction(f.wire, { rpc, simulate: false })
    expect(p.simulation).toBeNull()
    expect(calls.map((c) => c.method)).toEqual(['getMultipleAccounts'])
    expect(p.lookupTables.every((t) => t.resolved)).toBe(true)
  })

  it('tables passed in are not fetched again', async () => {
    const f = loadFixture('messages/v0-lookup-tables.json')
    const { rpc, calls } = mockRpc({ value: replyFrom(f) })
    await describeTransaction(f.wire, { rpc, lookupTables: f.lookupTables as Record<string, string[]> })
    expect(calls.map((c) => c.method)).toEqual(['simulateTransaction'])
  })

  it('a message without a fee payer or lifetime is decoded but not simulated', async () => {
    const msg = pipe(createTransactionMessage({ version: 0 }), (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(FILLER), destination: FILLER, amount: 1n }), m))
    const sim = vi.fn()
    const p = await describeTransaction(msg, { rpc: { simulateTransaction: sim, getMultipleAccounts: sim } as unknown as PreviewRpc })
    expect(sim).not.toHaveBeenCalled()
    expect(p.instructions[0]).toMatchObject({ name: 'TransferSol' })
    expect(p.warnings.map((w) => w.code)).toContain('simulation-unavailable')
  })

  it('a compilable message (fee payer + lifetime) is compiled and simulated', async () => {
    const f = loadFixture('system/transfer-sol-v1.json')
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(FILLER, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(FILLER), destination: 'Dest111111111111111111111111111111111111111' as Address, amount: 1n }), m),
    )
    const { rpc, calls } = mockRpc({ value: replyFrom(f) })
    const p = await describeTransaction(msg, { rpc })
    expect(calls.map((c) => c.method)).toEqual(['simulateTransaction'])
    expect(p.signers).toEqual([{ address: FILLER, signed: null }])
    expect(p.simulation!.ok).toBe(true)
  })
})

describe('fetchLookupTables', () => {
  it('keeps real tables; skips missing accounts, accounts of other owners and data that does not decode', async () => {
    const good = tableAccount(['So11111111111111111111111111111111111111112'])
    const { rpc } = mockRpc({
      tables: {
        Tab1e11111111111111111111111111111111111111: good,
        Tab1e21111111111111111111111111111111111111: tableAccount(['So11111111111111111111111111111111111111112'], '11111111111111111111111111111111'),
        Tab1e31111111111111111111111111111111111111: { ...good, data: ['AAEC', 'base64'] },
      },
    })
    const out = await fetchLookupTables(rpc, ['Tab1e11111111111111111111111111111111111111', 'Tab1e21111111111111111111111111111111111111', 'Tab1e31111111111111111111111111111111111111', 'Tab1e41111111111111111111111111111111111111'])
    expect(out).toEqual({ Tab1e11111111111111111111111111111111111111: ['So11111111111111111111111111111111111111112'] })
  })

  it('asks in batches of 100, each address once', async () => {
    const { rpc, calls } = mockRpc({ tables: {} })
    const many = Array.from({ length: 150 }, (_, i) => getAddressDecoder().decode(new Uint8Array(32).fill(i + 1)))
    await fetchLookupTables(rpc, [...many, ...many])
    expect(calls.map((c) => (c.args[0] as string[]).length)).toEqual([100, 50])
    expect(await fetchLookupTables(rpc, [])).toEqual({})
  })
})
