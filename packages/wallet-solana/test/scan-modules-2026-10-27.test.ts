// Scan 2026-10-27 (modules): the serialized-transaction guard learns the instruction shapes an
// operation takes (F1: a lending "deposit" that also withdraws the collateral and transfers it away
// passed on net balances), refuses negative bounds (F10/F11: a negative minimum read as permission to
// lose that much) and can cap what the wallet receives (a borrow bigger than asked).
import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables, createNoopSigner,
  createTransactionMessage, getAddressEncoder, getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getSyncNativeInstruction, getTransferInstruction } from '@solana-program/token'
import { getSetComputeUnitLimitInstruction, COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget'
import { DEFAULT_PROGRAM_ALLOWLIST, UnsafeTransactionError, WSOL_MINT, WalletManagerSolana, type SerializedTxGuard, type SolanaRpc } from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const ATTACKER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address
const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD' as Address
const MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF' as Address
const OBLIGATION = 'zncEB2kLmREYgbVG6aPS6D6NamMjDskXM5pwh5Ejmeu' as Address
const OTHER_OBLIGATION = 'BYojGuT56e2TUb8PQwRyT1wL5X5Ekv4kZH1HUQgBu6Zg' as Address
const RESERVE = 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59' as Address
const TABLE = 'AddressLookupTab1e1111111111111111111111111' as Address
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'
const SOL = 1_000_000_000n
const FEE = 5_000n
const ATA_RENT = 2_039_280n
const DEPOSIT = 'd8e0bf1bcc9766af'
const WITHDRAW = 'eb34779895c51407'
const BORROW = 'a1808ff5abc7c206'

type State = { lamports: bigint; owner: string; data: Uint8Array } | null
const pk = (a: string) => getAddressEncoder().encode(a as Address) as Uint8Array
function token(mint: Address, owner: Address, amount: bigint): State {
  const data = new Uint8Array(165)
  data.set(pk(mint), 0)
  data.set(pk(owner), 32)
  new DataView(data.buffer).setBigUint64(64, amount, true)
  data[108] = 1
  return { lamports: ATA_RENT, owner: TOKEN_PROGRAM_ADDRESS, data }
}
const sys = (lamports: bigint): State => ({ lamports, owner: '11111111111111111111111111111111', data: new Uint8Array() })
const toRpc = (s: State) => (s ? { lamports: s.lamports, owner: s.owner, data: [Buffer.from(s.data).toString('base64'), 'base64'], executable: false, rentEpoch: 0n, space: BigInt(s.data.length) } : null)

/** pre/post states by address; base64 getMultipleAccounts reads the pre-state, jsonParsed serves the lookup table. */
function fakeRpc(pre: Record<string, State>, post: Record<string, State>, table: Address[] = []) {
  const calls: string[] = []
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getMultipleAccounts: (list, cfg) => ((cfg as { encoding?: string } | undefined)?.encoding === 'base64'
      ? { value: (list as string[]).map((a) => toRpc(pre[a] ?? null)) }
      : { value: [{ data: { parsed: { info: { addresses: table }, type: 'lookupTable' }, program: 'address-lookup-table' }, owner: 'AddressLookupTab1e1111111111111111111111111', executable: false, lamports: 1n, rentEpoch: 0n, space: 0n }] }),
    simulateTransaction: (_w, cfg) => {
      const addrs = (cfg as { accounts: { addresses: string[] } }).accounts.addresses
      return { value: { err: null, unitsConsumed: 100_000n, logs: [], accounts: addrs.map((a) => toRpc(post[a] ?? null)) } }
    },
    getFeeForMessage: () => ({ value: FEE }),
    sendTransaction: () => 'C'.repeat(87),
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { calls.push(m); const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, calls }
}

function wire(instructions: Instruction[], lookup?: Address[]): string {
  let msg = pipe(
    createTransactionMessage({ version: 0 }),
    (x) => setTransactionMessageFeePayer(ME, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, x),
    (x) => appendTransactionMessageInstructions(instructions, x),
  ) as TransactionMessage
  if (lookup) msg = compressTransactionMessageUsingAddressLookupTables(msg as never, { [TABLE]: lookup }) as never
  return getBase64EncodedWireTransaction(compileTransaction(msg as never) as Transaction)
}

const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'))
const u64le = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b }
/** A klend call shaped like the V2 deposit / withdraw / borrow: owner, obligation, market, reserve, …, the wallet's token account. */
function klend(disc: string, amount: bigint, obligation: Address, ata: Address): Instruction {
  return {
    programAddress: KLEND,
    accounts: [
      { address: ME, role: AccountRole.WRITABLE_SIGNER },
      { address: obligation, role: AccountRole.WRITABLE },
      { address: MARKET, role: AccountRole.READONLY },
      { address: RESERVE, role: AccountRole.WRITABLE },
      { address: ata, role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.from([...hex(disc), ...u64le(amount)]),
  }
}

const KLEND_PROGRAMS = [...DEFAULT_PROGRAM_ALLOWLIST, KLEND]

async function setup() {
  const [usdcAta] = await findAssociatedTokenPda({ mint: USDC, owner: ME, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const [attackerAta] = await findAssociatedTokenPda({ mint: USDC, owner: ATTACKER, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const depositRules = (ata: Address) => [
    { program: COMPUTE_BUDGET_PROGRAM_ADDRESS as string },
    { program: KLEND, data: DEPOSIT, accounts: { 0: ME, 1: OBLIGATION, 2: MARKET, 4: ata } },
  ]
  return { usdcAta, attackerAta, depositRules }
}

describe('serialized guard: instruction rules (scan 2026-10-27 modules, F1)', () => {
  it('a deposit that matches its rules passes and is checked on balances as before', async () => {
    const { usdcAta, depositRules } = await setup()
    const pre = { [ME]: sys(SOL), [usdcAta]: token(USDC, ME, 50_000_000n) }
    const post = { [ME]: sys(SOL - FEE), [usdcAta]: token(USDC, ME, 49_000_000n) }
    const f = fakeRpc(pre, post)
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
    const tx = wire([getSetComputeUnitLimitInstruction({ units: 300_000 }), klend(DEPOSIT, 1_000_000n, OBLIGATION, usdcAta)])
    const check = await a.checkSerialized(tx, { programAllowlist: KLEND_PROGRAMS, instructions: depositRules(usdcAta), expect: { maxLamportsOut: 10_000_000n, maxTokenOut: { mint: USDC, amount: 1_000_000n } } })
    expect(check.tokenOutDelta).toBe(-1_000_000n)
  })

  it('F1: a 1-unit "deposit" that also withdraws the collateral and transfers it to the attacker is refused before simulation', async () => {
    const { usdcAta, attackerAta, depositRules } = await setup()
    // Net balances hold: +50 USDC from the withdrawal, −50 USDC + 1 to the attacker → −1 USDC, within maxTokenOut.
    const pre = { [ME]: sys(SOL), [usdcAta]: token(USDC, ME, 1_000_000n) }
    const post = { [ME]: sys(SOL - FEE), [usdcAta]: token(USDC, ME, 0n) }
    const f = fakeRpc(pre, post)
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
    const tx = wire([
      klend(DEPOSIT, 1n, OBLIGATION, usdcAta),
      klend(WITHDRAW, 50_000_000_000n, OBLIGATION, usdcAta),
      getTransferInstruction({ source: usdcAta, destination: attackerAta, authority: createNoopSigner(ME), amount: 50_000_000_001n }),
    ])
    const guard: SerializedTxGuard = { programAllowlist: KLEND_PROGRAMS, instructions: depositRules(usdcAta), expect: { maxLamportsOut: 10_000_000n, maxTokenOut: { mint: USDC, amount: 1_000_000n } } }
    const err = await a.checkSerialized(tx, guard).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnsafeTransactionError)
    expect((err as UnsafeTransactionError).code).toBe('unexpected-instruction')
    expect((err as Error).message).toMatch(/Instruction 1 \(KLend2g3/)
    expect(f.calls).not.toContain('simulateTransaction')
    // Without the withdrawal, the transfer alone is the odd one out.
    const transferOnly = wire([klend(DEPOSIT, 1n, OBLIGATION, usdcAta), getTransferInstruction({ source: usdcAta, destination: attackerAta, authority: createNoopSigner(ME), amount: 1n })])
    await expect(a.checkSerialized(transferOnly, guard)).rejects.toMatchObject({ code: 'unexpected-instruction', details: [TOKEN_PROGRAM_ADDRESS] })
  })

  it('pinned accounts are compared after lookup tables are resolved: another obligation behind the table is refused', async () => {
    const { usdcAta, depositRules } = await setup()
    const pre = { [ME]: sys(SOL), [usdcAta]: token(USDC, ME, 5_000_000n) }
    const post = { [ME]: sys(SOL - FEE), [usdcAta]: token(USDC, ME, 4_000_000n) }
    const guard: SerializedTxGuard = { programAllowlist: KLEND_PROGRAMS, instructions: depositRules(usdcAta), expect: { maxLamportsOut: 10_000_000n, maxTokenOut: { mint: USDC, amount: 1_000_000n } } }
    const ok = fakeRpc(pre, post, [OBLIGATION, RESERVE])
    const a = await new WalletManagerSolana(SEED, { provider: ok.rpc }).getAccount(0)
    const viaTable = wire([klend(DEPOSIT, 1_000_000n, OBLIGATION, usdcAta)], [OBLIGATION, RESERVE])
    expect(Buffer.from(viaTable, 'base64').includes(Buffer.from(pk(OBLIGATION)))).toBe(false) // really behind the table
    await expect(a.checkSerialized(viaTable, guard)).resolves.toMatchObject({ tokenOutDelta: -1_000_000n })

    const bad = fakeRpc(pre, post, [OTHER_OBLIGATION, RESERVE])
    const b = await new WalletManagerSolana(SEED, { provider: bad.rpc }).getAccount(0)
    const elsewhere = wire([klend(DEPOSIT, 1_000_000n, OTHER_OBLIGATION, usdcAta)], [OTHER_OBLIGATION, RESERVE])
    await expect(b.checkSerialized(elsewhere, guard)).rejects.toMatchObject({ code: 'unexpected-instruction' })
  })

  it('data prefixes and exact lengths are enforced; malformed rules are the caller\'s error, not "match anything"', async () => {
    const { usdcAta } = await setup()
    const [wsolAta] = await findAssociatedTokenPda({ mint: WSOL_MINT as Address, owner: ME, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    const f = fakeRpc({ [ME]: sys(SOL) }, { [ME]: sys(SOL - FEE) })
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
    const expect0 = { maxLamportsOut: 10_000_000n }
    const syncRule = [{ program: TOKEN_PROGRAM_ADDRESS as string, data: '11', dataLength: 1, accounts: { 0: wsolAta } }]
    await expect(a.checkSerialized(wire([getSyncNativeInstruction({ account: wsolAta })]), { instructions: syncRule, expect: expect0 })).resolves.toBeDefined()
    // Same tag, one more byte: not the instruction the rule describes.
    const padded: Instruction = { programAddress: TOKEN_PROGRAM_ADDRESS, accounts: [{ address: wsolAta, role: AccountRole.WRITABLE }], data: Uint8Array.of(0x11, 0) }
    await expect(a.checkSerialized(wire([padded]), { instructions: syncRule, expect: expect0 })).rejects.toMatchObject({ code: 'unexpected-instruction' })
    // A different discriminator on an allowed program.
    const borrow = wire([klend(BORROW, 1n, OBLIGATION, usdcAta)])
    await expect(a.checkSerialized(borrow, { programAllowlist: KLEND_PROGRAMS, instructions: [{ program: KLEND, data: DEPOSIT.toUpperCase() }], expect: expect0 })).rejects.toMatchObject({ code: 'unexpected-instruction' })
    for (const instructions of [[], [{ program: KLEND, data: 'zz' }], [{ program: KLEND, data: 'abc' }], [{ program: KLEND, accounts: { x: ME } }], [{ program: KLEND, accounts: { 0: [] } }], [{ program: KLEND, data: 'aabb', dataLength: 1 }], [{ program: '' }]]) {
      await expect(a.checkSerialized(borrow, { programAllowlist: KLEND_PROGRAMS, instructions: instructions as never, expect: expect0 })).rejects.toBeInstanceOf(TypeError)
    }
  })
})

describe('serialized guard: bounds (scan 2026-10-27 modules, F10/F11)', () => {
  it('a negative or non-bigint bound is refused before the network is consulted', async () => {
    const { usdcAta } = await setup()
    const f = fakeRpc({}, {})
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
    const tx = wire([klend(WITHDRAW, 1n, OBLIGATION, usdcAta)])
    const bad: Array<SerializedTxGuard['expect']> = [
      { maxLamportsOut: -1n },
      { maxLamportsOut: 0n, tokenIn: { mint: USDC, minAmount: -995_000_000_000n } }, // F10: the API's "-1000000" deposit
      { maxLamportsOut: 0n, maxTokenOut: { mint: USDC, amount: -1n } },
      { maxLamportsOut: 10_000 as unknown as bigint },
      { maxLamportsOut: 0n, tokenIn: { mint: USDC, minAmount: 5n, maxAmount: 4n } },
      { maxLamportsOut: 0n, tokenIn: { mint: USDC, minAmount: 0n, maxAmount: -1n } },
    ]
    for (const expect_ of bad) {
      await expect(a.checkSerialized(tx, { allowUnknownPrograms: true, expect: expect_ })).rejects.toMatchObject({ code: 'invalid-expectation' })
      await expect(a.simulateSerialized(tx, { allowUnknownPrograms: true, expect: expect_ })).resolves.toMatchObject({ ok: false, code: 'invalid-expectation' })
    }
    await expect(a.checkSerialized(tx, undefined as never)).rejects.toMatchObject({ code: 'invalid-expectation' })
    expect(f.calls).toEqual([])
  })

  it('tokenIn.maxAmount caps what the wallet may receive: a borrow bigger than asked is refused', async () => {
    const { usdcAta } = await setup()
    const pre = { [ME]: sys(SOL), [usdcAta]: token(USDC, ME, 0n) }
    const guard = (maxAmount: bigint): SerializedTxGuard => ({ programAllowlist: KLEND_PROGRAMS, expect: { maxLamportsOut: 10_000_000n, tokenIn: { mint: USDC, minAmount: 995_000n, maxAmount } } })
    const tx = wire([klend(BORROW, 1_000_000n, OBLIGATION, usdcAta)])
    const asked = fakeRpc(pre, { [ME]: sys(SOL - FEE), [usdcAta]: token(USDC, ME, 1_000_000n) })
    const a = await new WalletManagerSolana(SEED, { provider: asked.rpc }).getAccount(0)
    await expect(a.checkSerialized(tx, guard(1_000_000n))).resolves.toMatchObject({ tokenInDelta: 1_000_000n })
    const more = fakeRpc(pre, { [ME]: sys(SOL - FEE), [usdcAta]: token(USDC, ME, 40_000_000_000n) })
    const b = await new WalletManagerSolana(SEED, { provider: more.rpc }).getAccount(0)
    await expect(b.checkSerialized(tx, guard(1_000_000n))).rejects.toMatchObject({ code: 'token-in-excess' })
    // Native SOL in: the cap applies to the net lamport change.
    const sol = fakeRpc({ [ME]: sys(SOL) }, { [ME]: sys(SOL + 5n * SOL) })
    const c = await new WalletManagerSolana(SEED, { provider: sol.rpc }).getAccount(0)
    await expect(c.checkSerialized(tx, { programAllowlist: KLEND_PROGRAMS, expect: { maxLamportsOut: 0n, tokenIn: { mint: WSOL_MINT, minAmount: 0n, maxAmount: SOL } } })).rejects.toMatchObject({ code: 'token-in-excess' })
  })
})

describe('getAccountInfos', () => {
  it('reads raw accounts in the order asked, null where none exists', async () => {
    const { usdcAta } = await setup()
    const f = fakeRpc({ [usdcAta]: token(USDC, ME, 7n) }, {})
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
    const [missing, ata] = await a.getAccountInfos([OBLIGATION, usdcAta])
    expect(missing).toBeNull()
    expect(ata).toMatchObject({ owner: TOKEN_PROGRAM_ADDRESS, lamports: ATA_RENT })
    expect(new DataView(ata!.data.buffer, ata!.data.byteOffset).getBigUint64(64, true)).toBe(7n)
  })
})
