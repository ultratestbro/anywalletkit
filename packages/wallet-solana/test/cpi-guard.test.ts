import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, createNoopSigner, createTransactionMessage, none, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, some, type Address, type Instruction, type TransactionMessage,
} from '@solana/kit'
import { AccountState, TOKEN_PROGRAM_ADDRESS, getApproveInstruction, getTokenEncoder } from '@solana-program/token'
import { NetworkError } from '@anywalletkit/core'
import { WalletManagerSolana, type SolanaConfig, type SolanaRpc } from '../src/index.js'

// Audit 2026-10-25 round 3 (open item from the post-release round): the wallet's checks read
// top-level instructions only, so a program the wallet signs for could, by CPI, hand the wallet's
// account to a program, give it data, change a token account's owner or close authority, or leave a
// delegate allowance. The simulation every send already runs now also returns the post-state of
// the wallet and of its token accounts the transaction writes, and any of those changes is refused
// (unless allowAuthorityChanges; a delegate a top-level Approve sets is the user's own choice).

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const ATA = 'BQcdHdAQW1hczDbBi9hiegXPR7MzRYNM4gYHBJLjHCkS' as Address
const OTHER_TA = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1' as Address // someone else's token account
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address
const DRAINER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy' as Address
const PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address
const SYSTEM = '11111111111111111111111111111111'
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'

type Acc = { owner: string; data: Uint8Array } | null
const token = (o: { owner?: Address; delegate?: Address; delegatedAmount?: bigint; closeAuthority?: Address } = {}) => ({
  owner: TOKEN_PROGRAM_ADDRESS as string,
  data: getTokenEncoder().encode({
    mint: MINT, owner: o.owner ?? ME, amount: 100n, delegate: o.delegate ? some(o.delegate) : none(), state: AccountState.Initialized,
    isNative: none(), delegatedAmount: o.delegatedAmount ?? 0n, closeAuthority: o.closeAuthority ? some(o.closeAuthority) : none(),
  }) as Uint8Array,
})
const wallet = (owner = SYSTEM, data = new Uint8Array()) => ({ owner, data })

function fakeRpc(pre: Record<string, Acc>, post: Record<string, Acc> | 'missing') {
  const calls: string[] = []
  const wire = (a: Acc) => (a ? { data: [Buffer.from(a.data).toString('base64'), 'base64'], owner: a.owner, executable: false, lamports: 2_000_000n, rentEpoch: 0n, space: BigInt(a.data.length) } : null)
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getFeeForMessage: () => ({ value: 5000n }),
    getRecentPrioritizationFees: () => [],
    getAccountInfo: (a) => ({ value: wire(pre[String(a)] ?? null) }),
    getMultipleAccounts: (list) => ({ value: (list as unknown[]).map((a) => wire(pre[String(a)] ?? null)) }),
    simulateTransaction: (_w, cfg) => {
      const asked = (cfg as { accounts?: { addresses: unknown[] } }).accounts?.addresses.map(String)
      const accounts = asked && post !== 'missing' ? asked.map((a) => wire(a in post ? post[a]! : pre[a] ?? null)) : undefined
      return { value: { err: null, unitsConsumed: 20_000n, logs: [], ...(accounts ? { accounts } : {}) } }
    },
    sendTransaction: () => 'A'.repeat(87),
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { calls.push(m); const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, calls }
}
const account = (f: { rpc: SolanaRpc }, config: Partial<SolanaConfig> = {}) => new WalletManagerSolana(SEED, { provider: f.rpc, ...config }).getAccount(0)

/** A program call that writes the wallet and its token account (what a malicious program would get). */
const call: Instruction = { programAddress: PROGRAM, accounts: [{ address: ME, role: AccountRole.WRITABLE_SIGNER }, { address: ATA, role: AccountRole.WRITABLE }, { address: OTHER_TA, role: AccountRole.WRITABLE }], data: new Uint8Array([1]) }
const msg = (ixs: Instruction[]) => pipe(
  createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(ME, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, m),
  (m) => appendTransactionMessageInstructions(ixs, m),
) as unknown as TransactionMessage
const PRE = { [ME]: wallet(), [ATA]: token(), [OTHER_TA]: token({ owner: DRAINER }) }

describe('what a program does by CPI to the wallet and its token accounts', () => {
  const refused: Array<[string, Record<string, Acc>, string]> = [
    ["the wallet's account handed to a program", { [ME]: wallet(PROGRAM) }, 'wallet-owner'],
    ['data given to the wallet', { [ME]: wallet(SYSTEM, new Uint8Array(8)) }, 'wallet-owner'],
    ["a token account's owner changed", { [ATA]: token({ owner: DRAINER }) }, 'sets-authority'],
    ["a token account's close authority changed", { [ATA]: token({ closeAuthority: DRAINER }) }, 'sets-authority'],
    ['a delegate allowance no top-level Approve shows', { [ATA]: token({ delegate: DRAINER, delegatedAmount: 100n }) }, 'approves-delegate'],
  ]
  for (const [name, post, code] of refused) {
    it(`refuses ${name}`, async () => {
      const f = fakeRpc(PRE, post)
      await expect((await account(f)).sendTransaction(msg([call]))).rejects.toMatchObject({ name: 'UnsafeTransactionError', code })
      await expect((await account(f)).signTransaction(msg([call]))).rejects.toMatchObject({ code })
      expect(f.calls).not.toContain('sendTransaction')
    })
  }

  it("signs when nothing changes, when someone else's token account changes, and a delegate the user approves on top", async () => {
    await expect((await account(fakeRpc(PRE, {}))).sendTransaction(msg([call]))).resolves.toMatchObject({ hash: 'A'.repeat(87) })
    await expect((await account(fakeRpc(PRE, { [OTHER_TA]: token({ owner: PROGRAM }) }))).sendTransaction(msg([call]))).resolves.toBeDefined()
    const approve = getApproveInstruction({ source: ATA, delegate: DRAINER, owner: createNoopSigner(ME), amount: 100n })
    await expect((await account(fakeRpc(PRE, { [ATA]: token({ delegate: DRAINER, delegatedAmount: 100n }) }))).sendTransaction(msg([approve]))).resolves.toBeDefined()
  })

  it('allowAuthorityChanges lets it through; an RPC that does not return the post-state is a network error', async () => {
    await expect((await account(fakeRpc(PRE, { [ATA]: token({ owner: DRAINER }) }), { allowAuthorityChanges: true })).sendTransaction(msg([call]))).resolves.toBeDefined()
    await expect((await account(fakeRpc(PRE, 'missing'))).sendTransaction(msg([call]))).rejects.toBeInstanceOf(NetworkError)
  })

  it('without a simulation there is nothing to read and no extra call', async () => {
    const f = fakeRpc(PRE, { [ATA]: token({ owner: DRAINER }) })
    await (await account(f, { simulate: false, priorityFee: false })).sendTransaction(msg([call]))
    expect(f.calls).not.toContain('getMultipleAccounts')
    expect(f.calls).not.toContain('simulateTransaction')
  })
})
