import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getBase64Encoder,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Instruction, type SignatureBytes, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { TOKEN_PROGRAM_ADDRESS, getApproveInstruction, getCloseAccountInstruction, getMintEncoder, getSetAuthorityInstruction, AuthorityType } from '@solana-program/token'
import { TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder as getMint2022Encoder, getTransferCheckedWithFeeInstructionDataDecoder } from '@solana-program/token-2022'
import {
  MissingSignersError, SimulationError, UnsafeTransactionError, WalletManagerSolana, ZERO_ADDRESS, computeUnitLimitFromSimulation, describeTransaction,
  pickPriorityPrice, type SolanaConfig, type SolanaRpc,
} from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address // account 0
const RECIPIENT = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb' as Address // account 1
const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address
const FEE_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' as Address // any address: owned by Token-2022 in the fake
const TABLE = 'AddressLookupTab1e1111111111111111111111111' as Address
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'
const SOME_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address

const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64')
const legacyMint = b64(getMintEncoder().encode({ mintAuthority: null, supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: null }) as Uint8Array)
const feeMint = b64(
  getMint2022Encoder().encode({
    mintAuthority: null, supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: null,
    extensions: [{
      __kind: 'TransferFeeConfig', transferFeeConfigAuthority: OTHER, withdrawWithheldAuthority: OTHER, withheldAmount: 0n,
      olderTransferFee: { epoch: 0n, maximumFee: 1_000n, transferFeeBasisPoints: 100 },
      newerTransferFee: { epoch: 100n, maximumFee: 500n, transferFeeBasisPoints: 50 },
    }],
  }) as Uint8Array,
)

/** Fake @solana/kit Rpc: each method returns { send } like the real one, and records calls. */
function fakeRpc(overrides: Record<string, (...a: unknown[]) => unknown> = {}) {
  const sent: string[] = []
  const calls: string[] = []
  const account = (owner: string, data: string) => ({ value: { data: [data, 'base64'], owner, executable: false, lamports: 1n, rentEpoch: 0n, space: 0n } })
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getFeeForMessage: () => ({ value: 5000n }),
    getBalance: () => ({ value: 1_000_000_000n }),
    getAccountInfo: (addr) => (addr === USDC ? account(TOKEN_PROGRAM_ADDRESS, legacyMint) : addr === FEE_MINT ? account(TOKEN_2022_PROGRAM_ADDRESS, feeMint) : { value: null }),
    getEpochInfo: () => ({ epoch: 500n, absoluteSlot: 1n, blockHeight: 1n, slotIndex: 0n, slotsInEpoch: 1n, transactionCount: null }),
    // jsonParsed: the lookup table; base64: the CPI guard's pre-state read of the written accounts (none exist here)
    getMultipleAccounts: (list, cfg) => ((cfg as { encoding?: string } | undefined)?.encoding === 'base64' ? { value: (list as unknown[]).map(() => null) } : { value: [{ data: { parsed: { info: { addresses: [RECIPIENT, OTHER] }, type: 'lookupTable' }, program: 'address-lookup-table' }, owner: 'AddressLookupTab1e1111111111111111111111111', executable: false, lamports: 1n, rentEpoch: 0n, space: 0n }] }),
    simulateTransaction: (_w, cfg) => ({ value: { err: null, unitsConsumed: 20_000n, logs: ['Program log: ok'], ...((cfg as { accounts?: { addresses: unknown[] } } | undefined)?.accounts ? { accounts: (cfg as { accounts: { addresses: unknown[] } }).accounts.addresses.map(() => null) } : {}) } }), // post-state for the CPI guard (round 3)
    sendTransaction: (wire) => { sent.push(wire as string); return 'A'.repeat(87) },
    getRecentPrioritizationFees: () => [{ prioritizationFee: 0, slot: 1n }, { prioritizationFee: 7000, slot: 2n }],
    ...overrides,
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { calls.push(m); const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, sent, calls }
}

function decodeWire(wire: string) {
  const bytes = getBase64Encoder().encode(wire)
  const tx = getTransactionDecoder().decode(bytes)
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as { instructions: Array<{ programAddressIndex: number; data?: Uint8Array }>; staticAccounts: Address[]; addressTableLookups?: unknown[] }
  return { tx, msg }
}

async function wallet(f = fakeRpc(), config: Partial<SolanaConfig> = {}) {
  const m = new WalletManagerSolana(SEED, { provider: f.rpc, ...config })
  return { m, a: await m.getAccount(0), f }
}

function message(instructions: Instruction[], feePayer: Address = ADDR0): TransactionMessage {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (x) => setTransactionMessageFeePayer(feePayer, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, x),
    (x) => appendTransactionMessageInstructions(instructions, x),
  ) as TransactionMessage
}
const solIx = (from: Address, to: Address, amount: bigint) => getTransferSolInstruction({ source: createNoopSigner(from), destination: to, amount })
const budgetItems = (d: ReturnType<typeof describeTransaction>) => d.items.filter((i) => i.type === 'compute-budget') as Array<{ kind: string; value: bigint }>

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

  it('native transfer: auto priority fee + simulated CU limit, valid signature, fee = base + priority', async () => {
    const { a, m, f } = await wallet()
    const res = await a.transfer({ recipient: RECIPIENT, amount: 1_000n })
    // price = p75 of [0, 7000] = 7000 µL; limit = 20 000 × 1.1 = 22 000; priority = ceil(22 000 × 7000 / 1e6) = 154
    expect(res.quote).toMatchObject({ baseFee: 5000n, priorityFee: 154n, microLamports: 7000n, computeUnitLimit: 22_000, fee: 5154n })
    expect(res.fee).toBe(5154n)
    expect(res.hash).toBe('A'.repeat(87))
    const { tx, msg } = decodeWire(f.sent[0]!)
    expect(msg.staticAccounts[0]).toBe(ADDR0)
    const d = describeTransaction(f.sent[0]!, { account: ADDR0 })
    expect(d.kind).toBe('sol-transfer')
    expect(budgetItems(d)).toEqual(expect.arrayContaining([{ type: 'compute-budget', program: expect.any(String), kind: 'price', value: 7000n }, { type: 'compute-budget', program: expect.any(String), kind: 'limit', value: 22_000n }]))
    expect(d.items.find((i) => i.type === 'sol-transfer')).toMatchObject({ from: ADDR0, to: RECIPIENT, lamports: 1_000n })
    expect(d.signers).toEqual([{ address: ADDR0, signed: true }])
    const sig = tx.signatures[ADDR0]!
    expect(ed25519.verify(sig as unknown as Uint8Array, tx.messageBytes as unknown as Uint8Array, a.publicKey)).toBe(true)
    expect(f.calls.filter((c) => c === 'simulateTransaction')).toHaveLength(1)
    m.dispose()
  })

  it('SPL transfer uses transferChecked with the mint decimals, adds create-ATA only when the recipient ATA is missing', async () => {
    const { a, m, f } = await wallet()
    await a.transfer({ token: USDC, recipient: RECIPIENT, amount: 1n })
    const d = describeTransaction(f.sent[0]!, { account: ADDR0 })
    expect(d.kind).toBe('spl-transfer')
    expect(d.items.find((i) => i.type === 'ata-create')).toMatchObject({ mint: USDC, owner: RECIPIENT, payer: ADDR0, idempotent: true })
    expect(d.items.find((i) => i.type === 'token-transfer')).toMatchObject({ tokenProgram: 'token', mint: USDC, decimals: 6, amount: 1n, authority: ADDR0 })
    expect(d.warnings).toEqual([])

    // The recipient's ATA exists (a token account); the recipient itself is a wallet with no account (round 3, M10 checks it).
    const present = fakeRpc({ getAccountInfo: (addr) => (addr === USDC ? { value: { data: [legacyMint, 'base64'], owner: TOKEN_PROGRAM_ADDRESS } } : addr === RECIPIENT ? { value: null } : { value: { data: ['', 'base64'], owner: TOKEN_PROGRAM_ADDRESS } }) })
    const w2 = await wallet(present)
    await w2.a.transfer({ token: USDC, recipient: RECIPIENT, amount: 1n })
    expect(describeTransaction(present.sent[0]!).items.some((i) => i.type === 'ata-create')).toBe(false)
    m.dispose(); w2.m.dispose()
  })

  it('Token-2022 transfer: token-2022 program, transferCheckedWithFee, fee from the current-epoch config', async () => {
    const { a, m, f } = await wallet()
    const q = await a.quoteTransfer({ token: FEE_MINT, recipient: RECIPIENT, amount: 10_000n })
    expect(q.tokenFee).toBe(50n) // 50 bps of 10 000, below the 500 cap
    const big = await a.quoteTransfer({ token: FEE_MINT, recipient: RECIPIENT, amount: 1_000_000n })
    expect(big.tokenFee).toBe(500n) // capped
    const res = await a.transfer({ token: FEE_MINT, recipient: RECIPIENT, amount: 10_000n })
    expect(res.quote.tokenFee).toBe(50n)
    const { msg } = decodeWire(f.sent[0]!)
    const transfer = msg.instructions.find((ix) => msg.staticAccounts[ix.programAddressIndex] === TOKEN_2022_PROGRAM_ADDRESS)!
    expect(transfer).toBeDefined()
    expect(getTransferCheckedWithFeeInstructionDataDecoder().decode(transfer.data!)).toMatchObject({ discriminator: 26, amount: 10_000n, decimals: 6, fee: 50n })
    const d = describeTransaction(f.sent[0]!)
    expect(d.kind).toBe('token2022-transfer')
    expect(d.items.find((i) => i.type === 'token-transfer')).toMatchObject({ tokenProgram: 'token-2022', fee: 50n })
    m.dispose()
  })

  it('priority fee: percentile + clamps, explicit values, disabled', async () => {
    expect(pickPriorityPrice([0, 1000, 3000, 7000], 0n, 5_000_000n)).toBe(7000n)
    expect(pickPriorityPrice([5, 6], 100n, 5_000_000n)).toBe(100n)
    expect(pickPriorityPrice([9_000_000], 0n, 5_000_000n)).toBe(5_000_000n)
    expect(pickPriorityPrice([], 0n, 5_000_000n)).toBe(0n)
    expect(computeUnitLimitFromSimulation(10n)).toBe(1_000)
    expect(computeUnitLimitFromSimulation(2_000_000n)).toBe(1_400_000)
    expect(computeUnitLimitFromSimulation(100_000n)).toBe(110_000)

    const explicit = await wallet(fakeRpc(), { priorityFee: { microLamports: 100n, computeUnitLimit: 50_000 } })
    const q = await explicit.a.quoteSendTransaction({ to: RECIPIENT, value: 1n })
    expect(q).toMatchObject({ microLamports: 100n, computeUnitLimit: 50_000, priorityFee: 5n, fee: 5005n })

    const off = await wallet(fakeRpc(), { priorityFee: false })
    await off.a.transfer({ recipient: RECIPIENT, amount: 1n })
    const d = describeTransaction(off.f.sent[0]!)
    expect(budgetItems(d)).toEqual([])
    expect(off.f.calls).not.toContain('getRecentPrioritizationFees')
    explicit.m.dispose(); off.m.dispose()
  })

  it('a failed simulation throws SimulationError before anything is signed or sent; simulate:false skips the gate', async () => {
    const failing = fakeRpc({ simulateTransaction: () => ({ value: { err: { InstructionError: [0, 'Custom'] }, unitsConsumed: 0n, logs: ['Program log: insufficient funds'] } }) })
    const w = await wallet(failing)
    const err = await w.a.sendTransaction({ to: RECIPIENT, value: 1n }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SimulationError)
    expect((err as SimulationError).logs).toEqual(['Program log: insufficient funds'])
    await expect(w.a.signTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(SimulationError)
    expect(failing.sent).toHaveLength(0)
    expect(failing.calls).not.toContain('sendTransaction')
    expect(await w.a.simulateTransaction({ to: RECIPIENT, value: 1n })).toMatchObject({ ok: false })

    const w2 = await wallet(fakeRpc({ simulateTransaction: () => ({ value: { err: 'boom', logs: null } }) }), { simulate: false })
    const res = await w2.a.sendTransaction({ to: RECIPIENT, value: 1n })
    expect(res.hash).toBe('A'.repeat(87))
    expect(res.quote.computeUnitLimit).toBeUndefined() // no usable simulation → no limit instruction
    w.m.dispose(); w2.m.dispose()
  })

  it('v0 transfer with a lookup table compresses the recipient into the table', async () => {
    const { a, m, f } = await wallet()
    await a.transfer({ recipient: RECIPIENT, amount: 5n, lookupTables: [TABLE] })
    const { msg } = decodeWire(f.sent[0]!)
    expect(msg.addressTableLookups).toHaveLength(1)
    expect(msg.staticAccounts).not.toContain(RECIPIENT)
    const unresolved = describeTransaction(f.sent[0]!, { account: ADDR0 })
    expect(unresolved.warnings.map((w) => w.code)).toContain('unresolved-lookup-tables')
    const resolved = describeTransaction(f.sent[0]!, { account: ADDR0, addressesByLookupTableAddress: { [TABLE]: [RECIPIENT, OTHER] } })
    expect(resolved.kind).toBe('sol-transfer')
    expect(resolved.items.find((i) => i.type === 'sol-transfer')).toMatchObject({ to: RECIPIENT, lamports: 5n })
    m.dispose()
  })

  it('provider wire (base64): co-signer missing → MissingSignersError; present → only our signature is added; foreign fee payer gated', async () => {
    const { a, m, f } = await wallet()
    const twoSigners = compileTransaction(message([solIx(OTHER, RECIPIENT, 1n)]) as never) as Transaction
    const wire = Buffer.from(getTransactionEncoder().encode(twoSigners)).toString('base64')
    await expect(a.signTransaction(wire)).rejects.toThrow(MissingSignersError)
    expect(describeTransaction(wire, { account: ADDR0 }).warnings.map((w) => w.code)).toContain('missing-signers')

    const otherSig = new Uint8Array(64).fill(7) as unknown as SignatureBytes
    const coSigned = { ...twoSigners, signatures: { ...twoSigners.signatures, [OTHER]: otherSig } } as Transaction
    const signed = await a.signTransaction(coSigned)
    const { tx } = decodeWire(signed)
    expect(tx.signatures[OTHER]).toEqual(otherSig)
    expect(ed25519.verify(tx.signatures[ADDR0] as unknown as Uint8Array, tx.messageBytes as unknown as Uint8Array, a.publicKey)).toBe(true)
    const res = await a.sendTransaction(signed) // already signed: broadcast as-is
    expect(f.sent[0]).toBe(signed)
    expect(res.quote.baseFee).toBe(10_000n)

    const foreignPayer = compileTransaction(message([solIx(ADDR0, RECIPIENT, 1n)], OTHER) as never) as Transaction
    const foreignCoSigned = { ...foreignPayer, signatures: { ...foreignPayer.signatures, [OTHER]: otherSig } } as Transaction
    await expect(a.signTransaction(foreignCoSigned)).rejects.toThrow(UnsafeTransactionError)
    const permissive = await wallet(fakeRpc(), { allowForeignFeePayer: true })
    expect(await permissive.a.signTransaction(foreignCoSigned)).toMatch(/^[A-Za-z0-9+/=]+$/)

    const notASigner = compileTransaction(message([solIx(OTHER, RECIPIENT, 1n)], OTHER) as never) as Transaction
    await expect(permissive.a.signTransaction({ ...notASigner, signatures: { [OTHER]: otherSig } } as Transaction)).rejects.toThrow(/not a required signer/)
    m.dispose(); permissive.m.dispose()
  })

  it('describeTransaction: kinds and warnings', () => {
    const ata = ADDR0 // any address stands in for a token account here
    const approve = describeTransaction(message([getApproveInstruction({ source: ata, delegate: OTHER, owner: createNoopSigner(ADDR0), amount: 0xffffffffffffffffn })]), { account: ADDR0 })
    expect(approve.kind).toBe('program-call')
    expect(approve.warnings.map((w) => w.code).sort()).toEqual(['approves-delegate', 'unlimited-approve'])
    expect(approve.items[0]).toMatchObject({ type: 'token-approve', unlimited: true, delegate: OTHER })

    const authority = describeTransaction(message([getSetAuthorityInstruction({ owned: ata, owner: createNoopSigner(ADDR0), authorityType: AuthorityType.AccountOwner, newAuthority: OTHER })]))
    expect(authority.warnings.map((w) => w.code)).toEqual(['sets-authority'])
    expect(authority.items[0]).toMatchObject({ type: 'set-authority', newAuthority: OTHER })

    const close = describeTransaction(message([getCloseAccountInstruction({ account: ata, destination: OTHER, owner: createNoopSigner(ADDR0) })]))
    expect(close.warnings.map((w) => w.code)).toEqual(['closes-account'])

    const opaque: Instruction = { programAddress: SOME_PROGRAM, accounts: [{ address: ADDR0, role: AccountRole.WRITABLE_SIGNER }], data: new Uint8Array([1, 2, 3]) }
    const call = describeTransaction(message([opaque]))
    expect(call.kind).toBe('program-call')
    expect(call.warnings.map((w) => w.code)).toEqual(['unknown-program'])
    expect(call.items[0]).toMatchObject({ type: 'program-call', program: SOME_PROGRAM, dataLength: 3 })

    const mixed = describeTransaction(message([solIx(ADDR0, RECIPIENT, 1n), opaque]))
    expect(mixed.kind).toBe('mixed')

    const foreign = describeTransaction(message([solIx(OTHER, RECIPIENT, 1n)], OTHER), { account: ADDR0 })
    expect(foreign.warnings.map((w) => w.code)).toEqual(['foreign-fee-payer'])

    expect(describeTransaction({ to: ZERO_ADDRESS, value: 1n }, { account: ADDR0 }).warnings.map((w) => w.code)).toEqual(['burn-address'])
    expect(describeTransaction(message([]))).toMatchObject({ kind: 'empty', feePayer: ADDR0 })
  })

  it('burn guard: transfers to the System program address are refused unless allowBurn', async () => {
    const { a, m, f } = await wallet()
    await expect(a.transfer({ recipient: ZERO_ADDRESS, amount: 1n })).rejects.toThrow(UnsafeTransactionError)
    await expect(a.sendTransaction({ to: ZERO_ADDRESS, value: 1n })).rejects.toThrow(/allowBurn/)
    expect(f.sent).toHaveLength(0)
    // With allowBurn our guard steps aside; kit itself then refuses to compile a
    // transfer whose destination is the invoked System program.
    const burner = await wallet(fakeRpc(), { allowBurn: true })
    const err = await burner.a.transfer({ recipient: ZERO_ADDRESS, amount: 1n }).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(UnsafeTransactionError)
    expect(burner.f.sent).toHaveLength(0)
    m.dispose(); burner.m.dispose()
  })

  it('transferMaxFee / transactionMaxFee stop before broadcast (priority fee included)', async () => {
    const { a, m, f } = await wallet(fakeRpc(), { transferMaxFee: 5100n, transactionMaxFee: 5100n })
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/maximum fee/)
    await expect(a.sendTransaction({ to: RECIPIENT, value: 1n })).rejects.toThrow(/maximum fee/)
    expect(f.sent).toHaveLength(0)
    const roomy = await wallet(fakeRpc(), { transferMaxFee: 5154n })
    await roomy.a.transfer({ recipient: RECIPIENT, amount: 1n })
    expect(roomy.f.sent).toHaveLength(1)
    m.dispose(); roomy.m.dispose()
  })

  it('signTransaction({to, value}) returns a base64 wire tx that sendTransaction re-broadcasts without re-signing', async () => {
    const { a, m, f } = await wallet()
    const wire = await a.signTransaction({ to: RECIPIENT, value: 10n })
    const { tx } = decodeWire(wire)
    const res = await a.sendTransaction(tx)
    expect(res.fee).toBe(5154n)
    expect(f.sent[0]).toBe(wire)
    const res2 = await a.sendTransaction(wire)
    expect(f.sent[1]).toBe(wire)
    expect(res2.quote.microLamports).toBe(7000n) // read back from the compiled compute-budget instruction
    m.dispose()
  })

  it('a caller-supplied compute budget is respected, not replaced', async () => {
    const { a, m, f } = await wallet()
    const { setTransactionMessageComputeUnitLimit, setTransactionMessageComputeUnitPrice } = await import('@solana/kit')
    const msg = setTransactionMessageComputeUnitLimit(30_000, setTransactionMessageComputeUnitPrice(12n, message([solIx(ADDR0, RECIPIENT, 1n)]) as never) as never)
    const res = await a.sendTransaction(msg as TransactionMessage)
    expect(res.quote).toMatchObject({ microLamports: 12n, computeUnitLimit: 30_000, priorityFee: 1n })
    expect(f.calls).not.toContain('getRecentPrioritizationFees')
    expect(budgetItems(describeTransaction(f.sent[0]!))).toHaveLength(2)
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

  it('offline wallet refuses network operations with a clear error, still describes, and read-only cannot sign', async () => {
    const m = new WalletManagerSolana(SEED)
    const a = await m.getAccount(0)
    await expect(a.getBalance()).rejects.toThrow(/provider/)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/provider/)
    expect(a.describeTransaction({ to: RECIPIENT, value: 1n }).kind).toBe('sol-transfer')
    expect((a.toReadOnlyAccount() as unknown as Record<string, unknown>).sign).toBeUndefined()
    m.dispose()
    await expect(a.sign('x')).rejects.toThrow(/disposed/)
  })
})
