import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getAddressEncoder,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { WalletManagerSolana, type SerializedTxGuard, type SolanaRpc } from '../src/index.js'

// Extension audit 2026-11-09, E9: the post-state guards watched the wallet, its wrapped SOL and its
// token accounts, but not the stake accounts (or nonce accounts) whose authority is the wallet.
// A program the wallet signs for could, by CPI, run Stake::Withdraw or Stake::Authorize with the
// wallet's signature — the top-level Stake checks never see it, the sheet showed only the fee.
// Both guards (checkSerialized and the simulation every send runs) now read those accounts'
// post-state and refuse a lamport decrease or authority change no top-level instruction explains.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const ATTACKER = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb' as Address
const STAKE_ACC = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const NEW_STAKE = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' as Address
const NONCE = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' as Address
const MY_TA = 'BQcdHdAQW1hczDbBi9hiegXPR7MzRYNM4gYHBJLjHCkS' as Address
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address
const EVIL = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy' as Address // an unknown program
const STAKE = 'Stake11111111111111111111111111111111111111' as Address
const SYSTEM = '11111111111111111111111111111111' as Address
const CLOCK = 'SysvarC1ock11111111111111111111111111111111' as Address
const HISTORY = 'SysvarStakeHistory1111111111111111111111111' as Address
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'
const SOL = 1_000_000_000n
const FEE = 5_000n
const STAKED = 3n * SOL
const RENT = 2_039_280n

type State = { lamports: bigint; owner: string; data: Uint8Array } | null
const enc = getAddressEncoder()
const key = (a: Address) => new Uint8Array(enc.encode(a))
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b }
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b }
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length } return o }

/** StakeStateV2::Stake (tag 2): rent reserve, staker, withdrawer, lockup (ts, epoch, custodian), then the delegation (zeros here). */
function stakeAccount(lamports: bigint, o: { staker?: Address; withdrawer?: Address; custodian?: Address; lockupEpoch?: bigint } = {}): State {
  const data = new Uint8Array(200)
  data.set(u32(2), 0)
  data.set(u64(2_282_880n), 4)
  data.set(key(o.staker ?? ME), 12)
  data.set(key(o.withdrawer ?? ME), 44)
  data.set(u64(o.lockupEpoch ?? 0n), 84)
  data.set(key(o.custodian ?? SYSTEM), 92)
  return { lamports, owner: STAKE, data }
}
/** A nonce account (Versions::Current, State::Initialized): authority at 8. */
function nonceAccount(lamports: bigint, authority: Address): State {
  const data = new Uint8Array(80)
  data.set(u32(1), 0)
  data.set(u32(1), 4)
  data.set(key(authority), 8)
  return { lamports, owner: SYSTEM, data }
}
function tokenAccount(owner: Address, amount: bigint): State {
  const data = new Uint8Array(165)
  data.set(key(MINT), 0)
  data.set(key(owner), 32)
  data.set(u64(amount), 64)
  data[108] = 1
  return { lamports: RENT, owner: TOKEN_PROGRAM_ADDRESS, data }
}
const sys = (lamports: bigint): State => ({ lamports, owner: SYSTEM, data: new Uint8Array() })
const toRpc = (s: State) => (s ? { lamports: s.lamports, owner: s.owner, data: [Buffer.from(s.data).toString('base64'), 'base64'], executable: false, rentEpoch: 0n, space: BigInt(s.data.length) } : null)

/** Simulation returns `post[a]` for each asked address (the pre-state where `post` says nothing). */
function fakeRpc(pre: Record<string, State>, post: Record<string, State>) {
  const sent: string[] = []
  const get = (m: Record<string, State>, a: string) => (a in m ? m[a]! : null)
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getRecentPrioritizationFees: () => [],
    getBalance: () => ({ value: get(pre, ME)?.lamports ?? 0n }),
    getAccountInfo: (a) => ({ value: toRpc(get(pre, String(a))) }),
    getMultipleAccounts: (addrs) => ({ value: (addrs as string[]).map((a) => toRpc(get(pre, String(a)))) }),
    simulateTransaction: (_w, cfg) => {
      const asked = ((cfg as { accounts?: { addresses: string[] } }).accounts?.addresses ?? []).map(String)
      return { value: { err: null, unitsConsumed: 50_000n, logs: [], accounts: asked.map((a) => toRpc(a in post ? post[a]! : get(pre, a))) } }
    },
    getFeeForMessage: () => ({ value: FEE }),
    sendTransaction: (w) => { sent.push(w as string); return 'C'.repeat(87) },
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, sent }
}
const account = (f: { rpc: SolanaRpc }) => new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0)
const message = (instructions: Instruction[]) => pipe(
  createTransactionMessage({ version: 0 }), (x) => setTransactionMessageFeePayer(ME, x),
  (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, x),
  (x) => appendTransactionMessageInstructions(instructions, x),
) as unknown as TransactionMessage
const wire = (instructions: Instruction[]) => getBase64EncodedWireTransaction(compileTransaction(message(instructions) as never) as Transaction)
/** What the extension passes for a dApp transaction: any program, at most the whole balance. */
const dappGuard = (balance: bigint): SerializedTxGuard => ({ allowUnknownPrograms: true, expect: { maxLamportsOut: balance } })

const W = AccountRole.WRITABLE, R = AccountRole.READONLY, WS = AccountRole.WRITABLE_SIGNER, RS = AccountRole.READONLY_SIGNER
const ix = (programAddress: Address, accounts: Array<[Address, AccountRole]>, data: Uint8Array): Instruction => ({ programAddress, accounts: accounts.map(([address, role]) => ({ address, role })), data })
/** An unknown program the wallet signs for, writing the given accounts (and passing the Stake / System programs for its CPI). */
const evil = (...writable: Address[]) => ix(EVIL, [[ME, WS], ...writable.map((a) => [a, W] as [Address, AccountRole]), [STAKE, R], [CLOCK, R], [HISTORY, R]], new Uint8Array([7]))
const withdraw = (from: Address, to: Address, lamports: bigint) => ix(STAKE, [[from, W], [to, W], [CLOCK, R], [HISTORY, R], [ME, RS]], cat(u32(4), u64(lamports)))
const split = (from: Address, to: Address, lamports: bigint) => ix(STAKE, [[from, W], [to, W], [ME, RS]], cat(u32(3), u64(lamports)))
const authorize = (stake: Address, to: Address, kind: 0 | 1) => ix(STAKE, [[stake, W], [CLOCK, R], [ME, RS]], cat(u32(1), key(to), u32(kind)))

const PRE: Record<string, State> = { [ME]: sys(SOL), [STAKE_ACC]: stakeAccount(STAKED) }

describe('E9: stake and nonce accounts of the wallet changed by CPI', () => {
  const drains: Array<[string, Record<string, State>, string]> = [
    ['Stake::Authorize(withdrawer → attacker) by CPI', { [ME]: sys(SOL - FEE), [STAKE_ACC]: stakeAccount(STAKED, { withdrawer: ATTACKER }) }, 'sets-authority'],
    ['Stake::Authorize(staker → attacker) by CPI', { [ME]: sys(SOL - FEE), [STAKE_ACC]: stakeAccount(STAKED, { staker: ATTACKER }) }, 'sets-authority'],
    ['Stake::SetLockup(custodian = attacker) by CPI', { [ME]: sys(SOL - FEE), [STAKE_ACC]: stakeAccount(STAKED, { custodian: ATTACKER, lockupEpoch: 99_999n }) }, 'sets-authority'],
    ['Stake::Withdraw(everything → attacker) by CPI', { [ME]: sys(SOL - FEE), [STAKE_ACC]: null }, 'moves-lamports'],
    ['Stake::Withdraw(part → attacker) by CPI', { [ME]: sys(SOL - FEE), [STAKE_ACC]: stakeAccount(SOL) }, 'moves-lamports'],
  ]

  for (const [name, post, code] of drains) {
    it(`checkSerialized (dApp guard) refuses ${name}`, async () => {
      const f = fakeRpc(PRE, post)
      const a = await account(f)
      await expect(a.checkSerialized(wire([evil(STAKE_ACC)]), dappGuard(SOL))).rejects.toMatchObject({ name: 'UnsafeTransactionError', code })
      await expect(a.sendSerialized(wire([evil(STAKE_ACC)]), dappGuard(SOL))).rejects.toMatchObject({ code })
      expect(f.sent).toHaveLength(0)
    })
    it(`the send / sign simulation refuses ${name}`, async () => {
      const f = fakeRpc(PRE, post)
      const a = await account(f)
      await expect(a.sendTransaction(message([evil(STAKE_ACC)]))).rejects.toMatchObject({ name: 'UnsafeTransactionError', code })
      await expect(a.signTransaction(wire([evil(STAKE_ACC)]))).rejects.toMatchObject({ code })
      expect(f.sent).toHaveLength(0)
    })
  }

  it('refuses moving the stake into a split the program then hands away (split explained, value gone)', async () => {
    const post = { [ME]: sys(SOL - FEE), [STAKE_ACC]: stakeAccount(SOL), [NEW_STAKE]: stakeAccount(2n * SOL, { withdrawer: ATTACKER }) }
    const f = fakeRpc({ ...PRE, [NEW_STAKE]: { lamports: 0n, owner: STAKE, data: new Uint8Array(200) } }, post)
    const a = await account(f)
    const tx = [split(STAKE_ACC, NEW_STAKE, 2n * SOL), evil(NEW_STAKE)]
    await expect(a.checkSerialized(wire(tx), dappGuard(SOL))).rejects.toMatchObject({ code: 'moves-lamports' })
    await expect(a.sendTransaction(message(tx))).rejects.toMatchObject({ code: 'moves-lamports' })
  })

  it("refuses a nonce account's authority handed away or its lamports withdrawn by CPI", async () => {
    const pre = { ...PRE, [NONCE]: nonceAccount(1_447_680n, ME) }
    for (const [post, code] of [[nonceAccount(1_447_680n, ATTACKER), 'sets-authority'], [null, 'moves-lamports']] as const) {
      const f = fakeRpc(pre, { [ME]: sys(SOL - FEE), [NONCE]: post })
      const a = await account(f)
      await expect(a.checkSerialized(wire([evil(NONCE)]), dappGuard(SOL))).rejects.toMatchObject({ code })
      await expect(a.sendTransaction(message([evil(NONCE)]))).rejects.toMatchObject({ code })
    }
  })

  it("passes the wallet's own top-level Stake::Withdraw to itself (claim after a delayed unstake) and lists the changes", async () => {
    const post = { [ME]: sys(SOL - FEE + STAKED), [STAKE_ACC]: null }
    const f = fakeRpc(PRE, post)
    const a = await account(f)
    const check = await a.checkSerialized(wire([withdraw(STAKE_ACC, ME, STAKED)]), dappGuard(SOL))
    expect(check.lamportsDelta).toBe(STAKED - FEE)
    expect(check.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: ME, kind: 'wallet', lamportsBefore: SOL, lamportsAfter: SOL - FEE + STAKED }),
      expect.objectContaining({ address: STAKE_ACC, kind: 'stake', lamportsBefore: STAKED, lamportsAfter: 0n, closed: true }),
    ]))
    const res = await a.sendTransaction(message([withdraw(STAKE_ACC, ME, STAKED)]))
    expect(res.hash).toBe('C'.repeat(87))
  })

  it('passes a split, a merge-like move between own stake accounts and an authorize to the wallet itself', async () => {
    const pre = { ...PRE, [NEW_STAKE]: null }
    const post = { [ME]: sys(SOL - FEE), [STAKE_ACC]: stakeAccount(SOL), [NEW_STAKE]: stakeAccount(2n * SOL) }
    const f = fakeRpc(pre, post)
    const a = await account(f)
    await expect(a.checkSerialized(wire([split(STAKE_ACC, NEW_STAKE, 2n * SOL)]), dappGuard(SOL))).resolves.toBeTruthy()
    await expect(a.sendTransaction(message([split(STAKE_ACC, NEW_STAKE, 2n * SOL)]))).resolves.toBeTruthy()
    const f2 = fakeRpc(PRE, { [ME]: sys(SOL - FEE), [STAKE_ACC]: stakeAccount(STAKED, { staker: ME }) })
    await expect((await account(f2)).sendTransaction(message([authorize(STAKE_ACC, ME, 0)]))).resolves.toBeTruthy()
  })

  it('passes an unknown program that only reads or tops up a stake account of the wallet', async () => {
    const f = fakeRpc(PRE, { [ME]: sys(SOL - FEE - SOL / 10n), [STAKE_ACC]: stakeAccount(STAKED + SOL / 10n) })
    const a = await account(f)
    await expect(a.checkSerialized(wire([evil(STAKE_ACC)]), dappGuard(SOL))).resolves.toBeTruthy()
    await expect(a.sendTransaction(message([evil(STAKE_ACC)]))).resolves.toBeTruthy()
  })

  it("leaves other people's stake accounts alone (a pool's validator stake split into the wallet's new account)", async () => {
    const pool = stakeAccount(100n * SOL, { staker: ATTACKER, withdrawer: ATTACKER })
    const f = fakeRpc({ ...PRE, [STAKE_ACC]: pool, [NEW_STAKE]: null }, { [ME]: sys(SOL - FEE), [STAKE_ACC]: stakeAccount(99n * SOL, { staker: ATTACKER, withdrawer: ATTACKER }), [NEW_STAKE]: stakeAccount(SOL) })
    await expect((await account(f)).checkSerialized(wire([evil(STAKE_ACC, NEW_STAKE)]), dappGuard(SOL))).resolves.toBeTruthy()
  })

  it("counts the rent of the wallet's token account closed to someone else as spent", async () => {
    const f = fakeRpc({ ...PRE, [MY_TA]: tokenAccount(ME, 0n) }, { [ME]: sys(SOL - FEE), [MY_TA]: null })
    const check = await (await account(f)).checkSerialized(wire([evil(MY_TA)]), dappGuard(SOL))
    expect(check.lamportsDelta).toBe(-(FEE + RENT))
    expect(check.changes).toEqual(expect.arrayContaining([expect.objectContaining({ address: MY_TA, kind: 'token', lamportsBefore: RENT, lamportsAfter: 0n, closed: true })]))
  })
})
