import { describe, expect, it } from 'vitest'
import { UnsafeTransactionError, WalletAccountReadOnlySolana } from '@anywalletkit/wallet-solana'
import SplStakePoolProtocolSolana, { SPL_STAKE_POOL_ADDRESS_MAP, codec } from '../index.js'
// @ts-expect-error plain ESM
import { JITO_POOL_ACCOUNT } from './fixtures.js'

// scan 2026-10-30 follow-up: wallet-solana's default guard refused every delayed exit this module
// builds ("funds stake account … without making this wallet its staker and withdrawer"). The slot is
// created by the wallet for the Stake program and then filled by the stake pool's WithdrawStake, whose
// split CPI makes the account named as the user stake authority its staker and withdrawer. The guard
// only knew the Stake program's own Initialize / Split. It now also takes a WithdrawStake on the SPL
// Stake Pool program that splits into the slot and names this wallet as that authority; any other
// authority, program or shape is refused as before.

const JITO = SPL_STAKE_POOL_ADDRESS_MAP.jito!
const HOLDER = '9hNaQ3crLjWihWa5BeQgSYfrPY3eoDmHJAX2sTWE8nUC'
const HOLDER_ATA = '2j7QrGvzM4bavXuGjCorApRdSgHELy3YEpnLpdFhRRPF'
const HOLDER_SLOT0 = 'GkjDuXZZhStb16o4f1BLyYzV6K1GqUhsQ497whWRMRNH'
const ATTACKER = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb'
const VOTE_A = 'hy1oJTV2kX9acsqpwk7hbteqXFw9VDbWvbxoamFEufW'
const SOL = 10n ** 9n
const RENT = 2_077_224n
const EPOCH = 1030n

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const le64 = (x: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, x, true); return b }
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }
const POOL_STATE = codec.decodeStakePool(b64(JITO_POOL_ACCOUNT.data))
const VOTE_A_STAKE = await codec.findValidatorStakeAccount(JITO.pool, VOTE_A, 0)

function tokenAccount(owner: string, amount: bigint) {
  const d = new Uint8Array(165)
  d.set(codec.addressToBytes(JITO.mint), 0)
  d.set(codec.addressToBytes(owner), 32)
  d.set(le64(amount), 64)
  d[108] = 1
  return d
}
const validatorList = (vote: string, active: bigint) =>
  cat(Uint8Array.of(2), new Uint8Array(4), Uint8Array.of(1, 0, 0, 0), le64(active), le64(0n), le64(EPOCH), le64(0n), new Uint8Array(9), codec.addressToBytes(vote))

/** The reads the module makes for a 5 JitoSOL holder on the captured Jito pool. */
function node({ prefundedSlot = false } = {}) {
  const accounts: Record<string, { data: Uint8Array; lamports: bigint; owner: string }> = {
    [JITO.pool]: { data: b64(JITO_POOL_ACCOUNT.data), lamports: JITO_POOL_ACCOUNT.lamports, owner: codec.STAKE_POOL_PROGRAM },
    [HOLDER_ATA]: { data: tokenAccount(HOLDER, 5n * SOL), lamports: 2_039_280n, owner: codec.TOKEN_PROGRAM },
    [POOL_STATE.validatorList]: { data: validatorList(VOTE_A, 197_304n * SOL), lamports: 1n, owner: codec.STAKE_POOL_PROGRAM },
    ...(prefundedSlot ? { [HOLDER_SLOT0]: { data: new Uint8Array(), lamports: 890_880n, owner: codec.SYSTEM_PROGRAM } } : {}),
  }
  const info = (a: string) => (accounts[a] ? { data: [Buffer.from(accounts[a]!.data).toString('base64'), 'base64'], lamports: Number(accounts[a]!.lamports), owner: accounts[a]!.owner } : null)
  return {
    async request(method: string, params: any[]) {
      switch (method) {
        case 'getEpochInfo': return { epoch: Number(EPOCH), slotIndex: 100_000, slotsInEpoch: 432_000 }
        case 'getMinimumBalanceForRentExemption': return Number(RENT)
        case 'getStakeMinimumDelegation': return { value: Number(SOL) }
        case 'getAccountInfo': return { value: info(params[0]) }
        case 'getMultipleAccounts': return { value: params[0].map(info) }
        case 'getBalance': return { value: params[0] === POOL_STATE.reserveStake ? 1_045_392_561_161 : params[0] === VOTE_A_STAKE ? Number(197_304n * SOL) : Number(accounts[params[0]]?.lamports ?? 0n) }
        default: throw new Error(`unexpected ${method}`)
      }
    },
  }
}

interface Guard { describeTransaction(tx: unknown): unknown; enforce(description: unknown): void }
const guard = (config = {}) => new WalletAccountReadOnlySolana(HOLDER, { provider: 'http://127.0.0.1:1', ...config } as never) as unknown as Guard
const check = (tx: unknown, config = {}) => { const g = guard(config); g.enforce(g.describeTransaction(tx)) }

/** The module, sending through wallet-solana's own signing checks with the wallet's default config. */
function guarded(tamper: (tx: any) => any = (tx) => tx, provider = node()) {
  const sent: unknown[] = []
  const account = {
    async getAddress() { return HOLDER },
    async quoteSendTransaction(tx: unknown) { check(tamper(tx)); return { fee: 5_000n } },
    async sendTransaction(tx: unknown) { check(tamper(tx)); sent.push(tx); return { hash: 'ab'.repeat(32), fee: 5_000n } },
  }
  return { p: new SplStakePoolProtocolSolana(account, { provider }) as any, sent }
}
const refusal = async (run: () => Promise<unknown>) => { try { await run(); return 'signed' } catch (e) { return e instanceof UnsafeTransactionError ? e.code : String(e) } }

/** Rebuild the exit with its WithdrawStake changed by `f` (instruction index 3 after the two budget instructions). */
const withWithdraw = (f: (ix: any) => any) => (tx: any) => ({ ...tx, instructions: tx.instructions.map((ix: any, i: number) => (i === 3 ? f(ix) : ix)) })
const setAccount = (n: number, address: string) => (ix: any) => ({ ...ix, accounts: ix.accounts.map((a: any, i: number) => (i === n ? { ...a, address } : a)) })

describe('scan 2026-10-30 follow-up: the default Solana guard signs the SPL stake-pool delayed exit', () => {
  it('requestWithdrawal (delayed) and its quote pass the default guard: create slot + WithdrawStake + Deactivate', async () => {
    const { p, sent } = guarded()
    expect((await p.quoteRequestWithdrawal({ amount: SOL, mode: 'delayed' })).fee).toBe(5_000n)
    const r = await p.requestWithdrawal({ amount: SOL })
    expect(r.stakeAccount).toBe(HOLDER_SLOT0)
    const ixs = (sent[0] as { instructions: Array<{ programAddress: string; accounts: Array<{ address: string }>; data: Uint8Array }> }).instructions
    expect(ixs[3]!.programAddress).toBe(codec.STAKE_POOL_PROGRAM)
    expect([ixs[3]!.data[0], ixs[3]!.accounts[4]!.address, ixs[3]!.accounts[5]!.address]).toEqual([24, HOLDER_SLOT0, HOLDER])
  })

  it('a pre-funded slot (TransferWithSeed reclaim first, scan 2026-10-30 F16) passes too', async () => {
    const { p, sent } = guarded(undefined, node({ prefundedSlot: true }))
    expect((await p._getUnstakeSlots()).freeLamports).toBe(890_880n)
    await p.requestWithdrawal({ amount: SOL })
    expect((sent[0] as { instructions: unknown[] }).instructions).toHaveLength(6) // budget ×2, TransferWithSeed, CreateAccountWithSeed, WithdrawStake, Deactivate
  })

  it('still refused: the split made another key the user stake authority', async () => {
    const { p } = guarded(withWithdraw(setAccount(5, ATTACKER)))
    expect(await refusal(() => p.requestWithdrawal({ amount: SOL }))).toBe('sets-authority')
  })

  it('still refused: the same instruction on another program id', async () => {
    const { p } = guarded(withWithdraw((ix) => ({ ...ix, programAddress: 'SP1s4uFeTAX9jsXXmwyDs1gxYYf7cdDZ8qHUHVxE1yr' })))
    expect(await refusal(() => p.requestWithdrawal({ amount: SOL }))).toBe('sets-authority')
  })

  it('still refused: the split goes to another account than the funded slot', async () => {
    const { p } = guarded(withWithdraw(setAccount(4, ATTACKER)))
    expect(await refusal(() => p.requestWithdrawal({ amount: SOL }))).toBe('sets-authority')
  })

  it('still refused: another stake-pool instruction (DepositStake, tag 9) or malformed WithdrawStake data in its place', async () => {
    const tag9 = guarded(withWithdraw((ix) => ({ ...ix, data: Uint8Array.of(9) })))
    expect(await refusal(() => tag9.p.requestWithdrawal({ amount: SOL }))).toBe('sets-authority')
    const long = guarded(withWithdraw((ix) => ({ ...ix, data: cat(ix.data, Uint8Array.of(0)) })))
    expect(await refusal(() => long.p.requestWithdrawal({ amount: SOL }))).toBe('sets-authority')
  })

  it('still refused: the slot funded with no WithdrawStake at all', async () => {
    const { p } = guarded((tx: any) => ({ ...tx, instructions: tx.instructions.filter((_: unknown, i: number) => i !== 3) }))
    expect(await refusal(() => p.requestWithdrawal({ amount: SOL }))).toBe('sets-authority')
  })

  it('allowAuthorityChanges keeps skipping the check', async () => {
    const sent: unknown[] = []
    const account = { async getAddress() { return HOLDER }, async sendTransaction(tx: any) { const t = withWithdraw(setAccount(5, ATTACKER))(tx); check(t, { allowAuthorityChanges: true }); sent.push(t); return { hash: 'ab'.repeat(32), fee: 0n } } }
    await new (SplStakePoolProtocolSolana as any)(account, { provider: node() }).requestWithdrawal({ amount: SOL })
    expect(sent).toHaveLength(1)
  })
})
