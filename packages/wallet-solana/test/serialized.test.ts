import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getAddressEncoder,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getApproveInstruction, getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getSetAuthorityInstruction, AuthorityType } from '@solana-program/token'
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget'
import {
  JUPITER_V6_PROGRAM_ADDRESS, LIFI_TRACKING_PROGRAM_ADDRESS, RELAY_DEPOSITORY_PROGRAM_ADDRESS, SimulationError, UnsafeTransactionError, WalletManagerSolana, type SerializedTxGuard, type SolanaRpc,
} from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' as Address
const WSOL_TEMP = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' as Address
const JUP = JUPITER_V6_PROGRAM_ADDRESS as Address
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'
const SOL = 1_000_000_000n
const FEE = 5_000n
const ATA_RENT = 2_039_280n

type State = { lamports: bigint; owner: string; data: Uint8Array } | null
const pk = (a: string) => getAddressEncoder().encode(a as Address) as Uint8Array
/** SPL token account bytes: mint | owner | amount(u64 LE @64) | …zeros (165 bytes). */
function tokenAccount(mint: Address, owner: Address, amount: bigint): Uint8Array {
  const out = new Uint8Array(165)
  out.set(pk(mint), 0)
  out.set(pk(owner), 32)
  new DataView(out.buffer).setBigUint64(64, amount, true)
  out[108] = 1
  return out
}
const token = (mint: Address, owner: Address, amount: bigint): State => ({ lamports: ATA_RENT, owner: TOKEN_PROGRAM_ADDRESS, data: tokenAccount(mint, owner, amount) })
/** Same, with a live delegate (COption tag @72, pubkey @76, delegated_amount u64 @121). */
const tokenDelegated = (mint: Address, owner: Address, amount: bigint, delegate: Address, delegated: bigint): State => {
  const data = tokenAccount(mint, owner, amount)
  new DataView(data.buffer).setUint32(72, 1, true)
  data.set(pk(delegate), 76)
  new DataView(data.buffer).setBigUint64(121, delegated, true)
  return { lamports: ATA_RENT, owner: TOKEN_PROGRAM_ADDRESS, data }
}
const sys = (lamports: bigint): State => ({ lamports, owner: '11111111111111111111111111111111', data: new Uint8Array() })
const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64')
const toRpcAccount = (s: State) => (s ? { lamports: s.lamports, owner: s.owner, data: [b64(s.data), 'base64'], executable: false, rentEpoch: 0n, space: BigInt(s.data.length) } : null)

/** Fake RPC with explicit pre/post account states; simulate returns post-state for whatever addresses were requested. */
function fakeRpc(pre: Record<string, State>, post: Record<string, State>, overrides: Record<string, (...a: unknown[]) => unknown> = {}) {
  const sent: string[] = []
  const calls: string[] = []
  const simulated: string[][] = []
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getMultipleAccounts: (addrs) => ({ value: (addrs as string[]).map((a) => toRpcAccount(pre[a] ?? null)) }),
    simulateTransaction: (_wire, cfg) => {
      const addrs = (cfg as { accounts: { addresses: string[] } }).accounts.addresses
      simulated.push(addrs)
      return { value: { err: null, unitsConsumed: 150_000n, logs: ['Program JUP6 success'], accounts: addrs.map((a) => toRpcAccount(post[a] ?? null)) } }
    },
    getFeeForMessage: () => ({ value: FEE }),
    sendTransaction: (wire) => { sent.push(wire as string); return 'B'.repeat(87) },
    ...overrides,
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { calls.push(m); const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, sent, calls, simulated }
}

function wire(instructions: Instruction[]): string {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (x) => setTransactionMessageFeePayer(ADDR0, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, x),
    (x) => appendTransactionMessageInstructions(instructions, x),
  ) as TransactionMessage
  return getBase64EncodedWireTransaction(compileTransaction(msg as never) as Transaction)
}

/** A Jupiter-shaped route: compute budget, create our USDC ATA, the router call touching the given writable accounts, unwrap wSOL. */
function jupiterLike(opts: { writable: Address[]; closeTo?: Address; extra?: Instruction[]; usdcAta: Address }): Instruction[] {
  const payer = createNoopSigner(ADDR0)
  const route: Instruction = {
    programAddress: JUP,
    accounts: [{ address: ADDR0, role: AccountRole.WRITABLE_SIGNER }, ...opts.writable.map((address) => ({ address, role: AccountRole.WRITABLE }))],
    data: new Uint8Array([0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a, 1, 2, 3]),
  }
  return [
    getSetComputeUnitLimitInstruction({ units: 400_000 }),
    getCreateAssociatedTokenIdempotentInstruction({ ata: opts.usdcAta, mint: USDC, owner: ADDR0, payer, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    route,
    getCloseAccountInstruction({ account: WSOL_TEMP, destination: opts.closeTo ?? ADDR0, owner: payer }),
    ...(opts.extra ?? []),
  ]
}

async function setup() {
  const [usdcAta] = await findAssociatedTokenPda({ mint: USDC, owner: ADDR0, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const [usdtAta] = await findAssociatedTokenPda({ mint: USDT, owner: ADDR0, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const [otherUsdt] = await findAssociatedTokenPda({ mint: USDT, owner: OTHER, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const pre: Record<string, State> = {
    [ADDR0]: sys(SOL),
    [usdtAta]: token(USDT, ADDR0, 1_000_000n),
    [otherUsdt]: token(USDT, OTHER, 5_000_000n),
  }
  return { usdcAta, usdtAta, otherUsdt, pre }
}

const guard = (over: Partial<SerializedTxGuard['expect']> = {}, rest: Partial<SerializedTxGuard> = {}): SerializedTxGuard => ({
  expect: { maxLamportsOut: 20_000_000n, tokenIn: { mint: USDC, minAmount: 980_000n }, ...over },
  ...rest,
})

describe('provider-serialized transactions', () => {
  it('signs a Jupiter-like swap when the simulation shows the declared balance changes', async () => {
    const { usdcAta, usdtAta, pre } = await setup()
    const post: Record<string, State> = { ...pre, [ADDR0]: sys(SOL - FEE - ATA_RENT), [usdcAta]: token(USDC, ADDR0, 990_000n) }
    const f = fakeRpc(pre, post)
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
    const tx = wire(jupiterLike({ writable: [usdcAta, usdtAta], usdcAta }))
    const res = await a.sendSerialized(tx, guard())
    expect(res.hash).toBe('B'.repeat(87))
    expect(res.check.tokenInDelta).toBe(990_000n)
    expect(res.check.lamportsDelta).toBe(-(FEE + ATA_RENT))
    expect(res.check.watched).toEqual(expect.arrayContaining([ADDR0, usdcAta, usdtAta]))
    expect(f.sent).toHaveLength(1)
    // the wallet's signature was added; the wire bytes it signed are the provider's
    const sig = Buffer.from(f.sent[0]!, 'base64').subarray(1, 65)
    expect(sig.some((b) => b !== 0)).toBe(true)
    expect(f.calls.filter((c) => c === 'simulateTransaction')).toHaveLength(1)
  })

  it('refuses a program outside the allowlist before touching the network', async () => {
    const { usdcAta, usdtAta, pre } = await setup()
    const f = fakeRpc(pre, pre)
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
    const rogue: Instruction = { programAddress: OTHER, accounts: [{ address: ADDR0, role: AccountRole.WRITABLE_SIGNER }], data: new Uint8Array([9]) }
    const tx = wire(jupiterLike({ writable: [usdcAta, usdtAta], usdcAta, extra: [rogue] }))
    await expect(a.sendSerialized(tx, guard())).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'unknown-program', details: [OTHER] })
    expect(f.calls).not.toContain('simulateTransaction')
    expect(f.sent).toHaveLength(0)
    // explicit widening lets it through to the simulation
    const post = { ...pre, [ADDR0]: sys(SOL - FEE), [usdcAta]: token(USDC, ADDR0, 990_000n) }
    const f2 = fakeRpc(pre, post)
    const a2 = await new WalletManagerSolana(SEED, { provider: f2.rpc }).getAccount(0)
    await expect(a2.sendSerialized(tx, guard({}, { programAllowlist: [...(await import('../src/index.js')).DEFAULT_PROGRAM_ALLOWLIST, OTHER] }))).resolves.toMatchObject({ hash: 'B'.repeat(87) })
  })

  it("lets LI.FI's tracking program through by default (read-only memo-like call)", async () => {
    // Shape of every LI.FI cross-chain quote from Solana (2026-10-09): TrackV1
    // with the Clock sysvar + an epoch PDA, both read-only, 9 bytes of data.
    const { usdcAta, usdtAta, pre } = await setup()
    const post = { ...pre, [ADDR0]: sys(SOL - FEE), [usdcAta]: token(USDC, ADDR0, 990_000n) }
    const f = fakeRpc(pre, post)
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
    const track: Instruction = {
      programAddress: LIFI_TRACKING_PROGRAM_ADDRESS as Address,
      accounts: [
        { address: 'SysvarC1ock11111111111111111111111111111111' as Address, role: AccountRole.READONLY },
        { address: 'HGVc9L4uzjybCKChHS1aW2ZhEnKNVwDKtCkASVtxLnsR' as Address, role: AccountRole.READONLY },
      ],
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    }
    const tx = wire(jupiterLike({ writable: [usdcAta, usdtAta], usdcAta, extra: [track] }))
    await expect(a.sendSerialized(tx, guard())).resolves.toMatchObject({ hash: 'B'.repeat(87) })
  })

  it('accepts a Relay-style delegate approval on the swap input only when the simulation shows it spent', async () => {
    // LI.FI `relaydepository` (Solana → HyperEVM, 2026-10-09): approve the
    // depository on our USDT ATA, the program pulls the deposit in the same tx.
    const { usdcAta, usdtAta, pre } = await setup()
    const payer = createNoopSigner(ADDR0)
    const relay: Instruction = { programAddress: RELAY_DEPOSITORY_PROGRAM_ADDRESS as Address, accounts: [{ address: ADDR0, role: AccountRole.WRITABLE_SIGNER }, { address: usdtAta, role: AccountRole.WRITABLE }], data: new Uint8Array(48) }
    const approveIx = (source: Address, amount: bigint) => getApproveInstruction({ source, delegate: OTHER, owner: payer, amount })
    const tx = (ixs: Instruction[]) => wire([getSetComputeUnitLimitInstruction({ units: 400_000 }), ...ixs])
    const g = guard({ tokenIn: undefined, maxTokenOut: { mint: USDT, amount: 1_000_000n }, maxLamportsOut: 0n })
    // spent in the same transaction → fine
    const spent = fakeRpc(pre, { ...pre, [ADDR0]: sys(SOL - FEE), [usdtAta]: token(USDT, ADDR0, 0n) })
    const a = await new WalletManagerSolana(SEED, { provider: spent.rpc }).getAccount(0)
    await expect(a.sendSerialized(tx([approveIx(usdtAta, 1_000_000n), relay]), g)).resolves.toMatchObject({ hash: 'B'.repeat(87) })
    // the delegate is left with an allowance → refused, nothing signed
    const lingering = fakeRpc(pre, { ...pre, [ADDR0]: sys(SOL - FEE), [usdtAta]: tokenDelegated(USDT, ADDR0, 1_000_000n, OTHER, 1_000_000n) })
    const b = await new WalletManagerSolana(SEED, { provider: lingering.rpc }).getAccount(0)
    await expect(b.sendSerialized(tx([approveIx(usdtAta, 1_000_000n), relay]), g)).rejects.toMatchObject({ code: 'approves-delegate' })
    expect(lingering.sent).toHaveLength(0)
    // approving more than the declared input, an unlimited amount, or a non-input account → refused before any simulation
    for (const bad of [approveIx(usdtAta, 1_000_001n), approveIx(usdtAta, 0xffffffffffffffffn), approveIx(usdcAta, 1n)]) {
      const f = fakeRpc(pre, pre)
      const c = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
      await expect(c.sendSerialized(tx([bad, relay]), g)).rejects.toMatchObject({ code: 'approves-delegate' })
      expect(f.sent).toHaveLength(0)
    }
    // and without a declared token input (SOL source), any approval is refused
    const f2 = fakeRpc(pre, pre)
    const d = await new WalletManagerSolana(SEED, { provider: f2.rpc }).getAccount(0)
    await expect(d.sendSerialized(tx([approveIx(usdtAta, 1n), relay]), guard({ tokenIn: undefined }))).rejects.toMatchObject({ code: 'approves-delegate' })
  })

  it('ships the LI.FI Solana route programs in the default allowlist (owner-approved 2026-10-10)', async () => {
    const { DEFAULT_PROGRAM_ALLOWLIST, MAYAN_PROGRAM_ADDRESSES, DFLOW_V4_PROGRAM_ADDRESS, OKX_DEX_ROUTER_PROGRAM_ADDRESS, MEMO_V1_PROGRAM_ADDRESS } = await import('../src/index.js')
    for (const p of [DFLOW_V4_PROGRAM_ADDRESS, OKX_DEX_ROUTER_PROGRAM_ADDRESS, MEMO_V1_PROGRAM_ADDRESS, ...MAYAN_PROGRAM_ADDRESSES]) expect(DEFAULT_PROGRAM_ALLOWLIST).toContain(p)
    expect(new Set(DEFAULT_PROGRAM_ALLOWLIST).size).toBe(DEFAULT_PROGRAM_ALLOWLIST.length)
    // the list is frozen: nobody can push a program in at runtime
    expect(Object.isFrozen(DEFAULT_PROGRAM_ALLOWLIST)).toBe(true)
  })

  it('refuses a drain of a token account that is not part of the swap', async () => {
    const { usdcAta, usdtAta, pre } = await setup()
    // the route delivers the USDC but also empties our USDT ATA
    const post: Record<string, State> = { ...pre, [ADDR0]: sys(SOL - FEE), [usdcAta]: token(USDC, ADDR0, 990_000n), [usdtAta]: token(USDT, ADDR0, 0n) }
    const f = fakeRpc(pre, post)
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
    const tx = wire(jupiterLike({ writable: [usdcAta, usdtAta], usdcAta }))
    await expect(a.sendSerialized(tx, guard())).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'token-drain', details: [usdtAta] })
    expect(f.sent).toHaveLength(0)
    // …but the same debit is fine when the caller declared USDT as the swap input
    const f2 = fakeRpc(pre, post)
    const a2 = await new WalletManagerSolana(SEED, { provider: f2.rpc }).getAccount(0)
    const res = await a2.sendSerialized(tx, guard({ maxTokenOut: { mint: USDT, amount: 1_000_000n } }))
    expect(res.check.tokenOutDelta).toBe(-1_000_000n)
    // …and refused again when it takes more than declared
    const f3 = fakeRpc(pre, post)
    const a3 = await new WalletManagerSolana(SEED, { provider: f3.rpc }).getAccount(0)
    await expect(a3.sendSerialized(tx, guard({ maxTokenOut: { mint: USDT, amount: 500_000n } }))).rejects.toMatchObject({ code: 'token-out' })
    expect(f3.sent).toHaveLength(0)
  })

  it('refuses a slippage breach and an over-spend of SOL', async () => {
    const { usdcAta, usdtAta, pre } = await setup()
    const f = fakeRpc(pre, { ...pre, [ADDR0]: sys(SOL - FEE), [usdcAta]: token(USDC, ADDR0, 970_000n) })
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
    const tx = wire(jupiterLike({ writable: [usdcAta, usdtAta], usdcAta }))
    await expect(a.sendSerialized(tx, guard())).rejects.toMatchObject({ code: 'slippage', details: ['970000'] })
    expect(f.sent).toHaveLength(0)

    const f2 = fakeRpc(pre, { ...pre, [ADDR0]: sys(SOL - 30_000_000n), [usdcAta]: token(USDC, ADDR0, 990_000n) })
    const a2 = await new WalletManagerSolana(SEED, { provider: f2.rpc }).getAccount(0)
    await expect(a2.sendSerialized(tx, guard())).rejects.toMatchObject({ code: 'lamports-out' })
    expect(f2.sent).toHaveLength(0)
    // simulateSerialized reports instead of throwing
    const f3 = fakeRpc(pre, { ...pre, [ADDR0]: sys(SOL - 30_000_000n), [usdcAta]: token(USDC, ADDR0, 990_000n) })
    const a3 = await new WalletManagerSolana(SEED, { provider: f3.rpc }).getAccount(0)
    expect(await a3.simulateSerialized(tx, guard())).toMatchObject({ ok: false, code: 'lamports-out' })
  })

  it('refuses authority changes and rent sent elsewhere, and a failed simulation', async () => {
    const { usdcAta, usdtAta, pre } = await setup()
    const post = { ...pre, [ADDR0]: sys(SOL - FEE), [usdcAta]: token(USDC, ADDR0, 990_000n) }
    const a = async (f = fakeRpc(pre, post)) => ({ f, a: await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0) })
    const setAuth = getSetAuthorityInstruction({ owned: usdtAta, owner: createNoopSigner(ADDR0), authorityType: AuthorityType.AccountOwner, newAuthority: OTHER })
    let w = await a()
    await expect(w.a.sendSerialized(wire(jupiterLike({ writable: [usdcAta], usdcAta, extra: [setAuth] })), guard())).rejects.toMatchObject({ code: 'sets-authority' })
    w = await a()
    await expect(w.a.sendSerialized(wire(jupiterLike({ writable: [usdcAta], usdcAta, closeTo: OTHER })), guard())).rejects.toMatchObject({ code: 'closes-account' })
    w = await a(fakeRpc(pre, post, { simulateTransaction: () => ({ value: { err: { InstructionError: [2, 'Custom'] }, logs: ['Program log: slippage tolerance exceeded'], accounts: null } }) }))
    await expect(w.a.sendSerialized(wire(jupiterLike({ writable: [usdcAta], usdcAta })), guard())).rejects.toBeInstanceOf(SimulationError)
    expect(w.f.sent).toHaveLength(0)
  })

  it('measures a native SOL "token in" on the lamport balance', async () => {
    const { usdcAta, pre } = await setup()
    // USDC → SOL: our USDC ATA is debited, SOL comes in net of the fee
    const preWithUsdc = { ...pre, [usdcAta]: token(USDC, ADDR0, 1_000_000n) }
    const post = { ...preWithUsdc, [ADDR0]: sys(SOL - FEE + 50_000_000n), [usdcAta]: token(USDC, ADDR0, 0n) }
    const f = fakeRpc(preWithUsdc, post)
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
    const tx = wire(jupiterLike({ writable: [usdcAta], usdcAta }))
    const res = await a.sendSerialized(tx, { expect: { maxLamportsOut: 20_000_000n, tokenIn: { mint: '0x0000000000000000000000000000000000000000', minAmount: 49_000_000n }, maxTokenOut: { mint: USDC, amount: 1_000_000n } } })
    expect(res.check.lamportsDelta).toBe(50_000_000n - FEE)
    expect(res.check.tokenInDelta).toBeUndefined()
    const f2 = fakeRpc(preWithUsdc, { ...post, [ADDR0]: sys(SOL - FEE + 10_000_000n) })
    const a2 = await new WalletManagerSolana(SEED, { provider: f2.rpc }).getAccount(0)
    await expect(a2.sendSerialized(tx, { expect: { maxLamportsOut: 20_000_000n, tokenIn: { mint: '11111111111111111111111111111111', minAmount: 49_000_000n }, maxTokenOut: { mint: USDC, amount: 1_000_000n } } })).rejects.toMatchObject({ code: 'slippage' })
    expect(UnsafeTransactionError.name).toBe('UnsafeTransactionError')
  })
})
