import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getBase64EncodedWireTransaction, none, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, some, type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { AccountState, TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTokenEncoder } from '@solana-program/token'
import { JUPITER_V6_PROGRAM_ADDRESS, WalletManagerSolana, type SerializedTxGuard, type SolanaRpc } from '../src/index.js'

// Scan 2026-10-28 F3: the CPI guard (simulateGuarded, and checkSerialized's authority step) watched only token
// accounts that already existed and were the wallet's. A token account the same transaction creates had no
// pre-state, was never asked for in the simulation, and a delegate / close authority a program planted on it by
// CPI was signed. Every written account that may become a token account is now watched; a missing pre-state counts
// as "this wallet's, no delegate, no close authority"; this wallet's ATA created for another owner is refused.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address
const DRAINER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy' as Address
const PROGRAM = JUPITER_V6_PROGRAM_ADDRESS as Address
const SYSTEM = '11111111111111111111111111111111'
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'

type Acc = { owner: string; data: Uint8Array; lamports?: bigint } | null
const token = (o: { owner?: Address; delegate?: Address; delegatedAmount?: bigint; closeAuthority?: Address; amount?: bigint } = {}): Acc => ({
  owner: TOKEN_PROGRAM_ADDRESS as string,
  lamports: 2_039_280n,
  data: getTokenEncoder().encode({
    mint: MINT, owner: o.owner ?? ME, amount: o.amount ?? 0n, delegate: o.delegate ? some(o.delegate) : none(), state: AccountState.Initialized,
    isNative: none(), delegatedAmount: o.delegatedAmount ?? 0n, closeAuthority: o.closeAuthority ? some(o.closeAuthority) : none(),
  }) as Uint8Array,
})
const walletAcc: Acc = { owner: SYSTEM, data: new Uint8Array(), lamports: 1_000_000_000n }

/** An honest simulator: post-state for exactly the addresses asked for (the changed one, else the pre-state). */
function fakeRpc(pre: Record<string, Acc>, post: Record<string, Acc>) {
  const calls: string[] = []
  const asked: string[][] = []
  const wire = (a: Acc) => (a ? { data: [Buffer.from(a.data).toString('base64'), 'base64'], owner: a.owner, executable: false, lamports: a.lamports ?? 2_039_280n, rentEpoch: 0n, space: BigInt(a.data.length) } : null)
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getFeeForMessage: () => ({ value: 5000n }),
    getRecentPrioritizationFees: () => [],
    getAccountInfo: (a) => ({ value: wire(pre[String(a)] ?? null) }),
    getMultipleAccounts: (list) => ({ value: (list as unknown[]).map((a) => wire(pre[String(a)] ?? null)) }),
    simulateTransaction: (_w, cfg) => {
      const req = (cfg as { accounts?: { addresses: unknown[] } }).accounts?.addresses.map(String)
      if (req) asked.push(req)
      const accounts = req ? req.map((a) => wire(a in post ? post[a]! : pre[a] ?? null)) : undefined
      return { value: { err: null, unitsConsumed: 40_000n, logs: [], ...(accounts ? { accounts } : {}) } }
    },
    sendTransaction: () => 'A'.repeat(87),
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { calls.push(m); const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, calls, asked }
}
const account = (f: { rpc: SolanaRpc }) => new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
const msg = (ixs: Instruction[]) => pipe(
  createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(ME, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, m),
  (m) => appendTransactionMessageInstructions(ixs, m),
) as unknown as TransactionMessage
const wireOf = (ixs: Instruction[]) => getBase64EncodedWireTransaction(compileTransaction(msg(ixs) as never) as Transaction)

describe('F3: a token account the transaction creates is watched by the CPI guard', async () => {
  const [ATA] = await findAssociatedTokenPda({ owner: ME, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const create = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(ME), ata: ATA, owner: ME, mint: MINT })
  const call = (extra: Address[] = []): Instruction => ({
    programAddress: PROGRAM,
    accounts: [{ address: ME, role: AccountRole.WRITABLE_SIGNER }, { address: ATA, role: AccountRole.WRITABLE }, ...extra.map((address) => ({ address, role: AccountRole.WRITABLE })), { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY }],
    data: new Uint8Array([7]),
  })
  const planted: Array<[string, Acc, string]> = [
    ['delegate = attacker, u64::MAX', token({ delegate: DRAINER, delegatedAmount: 2n ** 64n - 1n }), 'approves-delegate'],
    ['closeAuthority = attacker', token({ closeAuthority: DRAINER }), 'sets-authority'],
    ['owner = attacker (this wallet\'s ATA)', token({ owner: DRAINER }), 'sets-authority'],
  ]

  for (const [name, state, code] of planted) {
    it(`sendTransaction / signTransaction: new ATA left with ${name} is refused, nothing sent`, async () => {
      const f = fakeRpc({ [ME]: walletAcc }, { [ATA]: state })
      const err = await (await account(f)).sendTransaction(msg([create, call()])).catch((e: unknown) => e)
      expect(err).toMatchObject({ name: 'UnsafeTransactionError', code })
      expect(f.calls).not.toContain('sendTransaction')
      expect(f.asked[0]).toContain(ATA)
      await expect((await account(fakeRpc({ [ME]: walletAcc }, { [ATA]: state }))).signTransaction(msg([create, call()]))).rejects.toMatchObject({ code })
    })

    it(`checkSerialized: new ATA left with ${name} is refused`, async () => {
      const f = fakeRpc({ [ME]: walletAcc }, { [ATA]: state })
      const guard: SerializedTxGuard = { expect: { maxLamportsOut: 10_000_000n } }
      await expect((await account(f)).checkSerialized(wireOf([create, call()]), guard)).rejects.toMatchObject({ name: 'UnsafeTransactionError', code })
    })
  }

  it('a pre-funded, data-less account counts as new too', async () => {
    const f = fakeRpc({ [ME]: walletAcc, [ATA]: { owner: SYSTEM, data: new Uint8Array(), lamports: 1n } }, { [ATA]: token({ delegate: DRAINER, delegatedAmount: 5n }) })
    await expect((await account(f)).sendTransaction(msg([create, call()]))).rejects.toMatchObject({ code: 'approves-delegate' })
  })

  it('a clean new ATA, and a new token account of someone else, pass', async () => {
    const [theirs] = await findAssociatedTokenPda({ owner: OTHER, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    const post = { [ATA]: token({ amount: 5n }), [theirs]: token({ owner: OTHER, delegate: DRAINER, delegatedAmount: 9n }) }
    const f = fakeRpc({ [ME]: walletAcc }, post)
    const res = await (await account(f)).sendTransaction(msg([create, call([theirs])]))
    expect(res.hash).toBe('A'.repeat(87))
    expect(f.asked[0]).toEqual(expect.arrayContaining([ME, ATA, theirs]))
    const g = fakeRpc({ [ME]: walletAcc }, post)
    await expect((await account(g)).checkSerialized(wireOf([create, call([theirs])]), { expect: { maxLamportsOut: 10_000_000n } })).resolves.toBeDefined()
  })

  it('the simulation is asked only for accounts of the transaction (the node caps the list at its account count)', async () => {
    const f = fakeRpc({ [ME]: walletAcc }, { [ATA]: token() })
    await (await account(f)).checkSerialized(wireOf([create, call()]), { expect: { maxLamportsOut: 10_000_000n, tokenIn: { mint: MINT, minAmount: 0n } } })
    const keys = new Set([ME, ATA, PROGRAM, TOKEN_PROGRAM_ADDRESS, MINT, SYSTEM, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'])
    for (const a of f.asked[0]!) expect(keys.has(a as Address)).toBe(true)
    expect(f.asked[0]!.length).toBeLessThanOrEqual(keys.size)
  })

  it('allowAuthorityChanges still overrides it', async () => {
    const f = fakeRpc({ [ME]: walletAcc }, { [ATA]: token({ delegate: DRAINER, delegatedAmount: 1n }) })
    const acc = await new WalletManagerSolana(SEED, { provider: f.rpc, allowAuthorityChanges: true }).getAccount(0)
    expect((await acc.sendTransaction(msg([create, call()]))).hash).toBe('A'.repeat(87))
  })
})
