/**
 * Accounts that hold this wallet's SOL without being token accounts: stake accounts whose staker or
 * withdrawer is the wallet, and nonce accounts whose authority is the wallet. A program the wallet
 * signs for can, by CPI, run Stake::Withdraw / Stake::Authorize / Stake::SetLockup or System
 * WithdrawNonceAccount / AuthorizeNonceAccount on them with the wallet's signature, which the
 * top-level checks never see (extension audit 2026-11-09, E9). The simulation guards read these
 * accounts' post-state and refuse what no top-level instruction the wallet reviews explains.
 */
import { getAddressDecoder } from '@solana/kit'
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system'
import { STAKE_PROGRAM_ADDRESS } from './describe.js'
import { UnsafeTransactionError } from './errors.js'
import { bytesEqual, parseTokenAccount, pubkeyBytes } from './serialized.js'
import type { SimulatedAccountChange, TransactionDescription } from './types.js'

/** An account as `getMultipleAccounts` / a simulation's post-state returns it. */
export type CustodyState = { lamports: bigint; owner: string; data: Uint8Array }
type States = ReadonlyMap<string, CustodyState | null | undefined>

/** The authority fields of an initialized stake account (`StakeStateV2::Initialized` / `Stake`). */
interface StakeMeta { staker: Uint8Array; withdrawer: Uint8Array; lockup: Uint8Array }
const STAKE_META_END = 124

/** Meta of an initialized stake account: tag u32 (1 = Initialized, 2 = Stake), rent reserve, staker 12..44, withdrawer 44..76, lockup 76..124. */
export function parseStakeMeta(st: CustodyState | null | undefined): StakeMeta | null {
  if (!st || st.owner !== STAKE_PROGRAM_ADDRESS || st.data.length < STAKE_META_END) return null
  const tag = new DataView(st.data.buffer, st.data.byteOffset, 4).getUint32(0, true)
  if (tag !== 1 && tag !== 2) return null
  return { staker: st.data.subarray(12, 44), withdrawer: st.data.subarray(44, 76), lockup: st.data.subarray(76, STAKE_META_END) }
}

/** Authority of an initialized nonce account (System-owned, 80 bytes: version u32, state u32 = 1, authority 8..40). */
export function parseNonceAuthority(st: CustodyState | null | undefined): Uint8Array | null {
  if (!st || st.owner !== SYSTEM_PROGRAM_ADDRESS || st.data.length !== 80) return null
  const view = new DataView(st.data.buffer, st.data.byteOffset, 8)
  if (view.getUint32(0, true) > 1 || view.getUint32(4, true) !== 1) return null
  return st.data.subarray(8, 40)
}

/**
 * Written accounts whose post-state the guard must read for custody: every Stake-program account (a
 * stake account of the wallet, or an uninitialized one a Split may fill with the wallet's stake) and
 * every nonce account the wallet is the authority of. Accounts that do not exist yet are watched by the
 * token-account guard already (they are fresh); their post-state is judged here too.
 */
export function custodyWatched(wallet: string, written: readonly string[], pre: States): string[] {
  const me = pubkeyBytes(wallet)
  return [...new Set(written)].filter((a) => {
    if (a === wallet) return false
    const st = pre.get(a)
    if (!st) return false
    if (st.owner === STAKE_PROGRAM_ADDRESS) return true
    const nonce = parseNonceAuthority(st)
    return nonce !== null && bytesEqual(nonce, me)
  })
}

type Item = TransactionDescription['items'][number]
const AUTHORITY_NAMES = new Set(['Authorize', 'AuthorizeWithSeed', 'AuthorizeChecked', 'AuthorizeCheckedWithSeed', 'SetLockup', 'SetLockupChecked'])
const stakeOf = (it: Item) => ((it.type === 'program-call' || it.type === 'unknown') && it.program === STAKE_PROGRAM_ADDRESS ? it.stake : undefined)

/**
 * The custody verdict over `accounts` (pre-state `pre`, simulated post-state `post`), or null.
 * - A stake or nonce account of the wallet must keep its authorities (staker, withdrawer, lockup /
 *   nonce authority) unless a top-level Authorize* / SetLockup* on that account sets them (the
 *   top-level Stake checks already require those to name this wallet and no foreign custodian).
 * - The lamports held by stake accounts this wallet withdraws from may only fall by what top-level
 *   Stake::Withdraw instructions pay to this wallet: a Split or Merge between the wallet's own stake
 *   accounts is neutral; stake moved into an account the wallet does not control after the
 *   transaction is refused, however it got there.
 * - A nonce account of the wallet may lose lamports only to a top-level WithdrawNonceAccount that
 *   pays this wallet.
 */
export function custodyRefusal(wallet: string, accounts: readonly string[], pre: States, post: States, description: TransactionDescription, hint: string): UnsafeTransactionError | null {
  const me = pubkeyBytes(wallet)
  const items = description.items
  const metaExplained = new Set<string>()
  let withdrawn = 0n
  const withdrawsFrom = new Set<string>()
  const nonceWithdrawals = new Set<string>()
  for (const it of items) {
    const s = stakeOf(it)
    const acc0 = (it.type === 'program-call' || it.type === 'unknown') ? it.accounts[0] ?? undefined : undefined
    if (s && acc0 && AUTHORITY_NAMES.has(s.name)) metaExplained.add(acc0)
    if (s && acc0 && s.name === 'Withdraw' && (it as { accounts: readonly (string | null)[] }).accounts[1] === wallet) {
      const src = parseStakeMeta(pre.get(acc0))
      if (src && bytesEqual(src.withdrawer, me)) { withdrawn += s.lamports ?? 0n; withdrawsFrom.add(acc0) }
    }
    if (it.type === 'program-call' && it.program === SYSTEM_PROGRAM_ADDRESS && it.instruction === 'WithdrawNonceAccount' && it.accounts[1] === wallet && it.accounts[0]) nonceWithdrawals.add(it.accounts[0])
  }

  let stakeBefore = 0n
  let stakeAfter = 0n
  for (const addr of accounts) {
    const before = pre.get(addr) ?? null
    const after = post.get(addr) ?? null
    const was = parseStakeMeta(before)
    const now = parseStakeMeta(after)
    if (was && bytesEqual(was.withdrawer, me)) stakeBefore += before!.lamports
    if (now && bytesEqual(now.withdrawer, me)) stakeAfter += after!.lamports
    if (was && (bytesEqual(was.staker, me) || bytesEqual(was.withdrawer, me)) && after !== null && after.lamports > 0n) {
      const changed = !now || !bytesEqual(was.staker, now.staker) || !bytesEqual(was.withdrawer, now.withdrawer) || !bytesEqual(was.lockup, now.lockup)
      if (changed && !metaExplained.has(addr)) return new UnsafeTransactionError(`Transaction changes the authorities or lockup of stake account ${addr}, which no top-level instruction shows${hint}`, 'sets-authority', [addr])
    }
    const nonceWas = parseNonceAuthority(before)
    if (nonceWas && bytesEqual(nonceWas, me)) {
      const nonceNow = parseNonceAuthority(after)
      if (after !== null && after.lamports > 0n && (!nonceNow || !bytesEqual(nonceNow, me))) {
        return new UnsafeTransactionError(`Transaction changes the authority of nonce account ${addr}${hint}`, 'sets-authority', [addr])
      }
      if ((after?.lamports ?? 0n) < before!.lamports && !nonceWithdrawals.has(addr)) {
        return new UnsafeTransactionError(`Transaction takes ${before!.lamports - (after?.lamports ?? 0n)} lamports from nonce account ${addr}, which no top-level instruction shows${hint}`, 'moves-lamports', [addr])
      }
    }
  }
  if (stakeAfter < stakeBefore - withdrawn) {
    const lost = stakeBefore - withdrawn - stakeAfter
    const where = [...accounts].filter((a) => { const w = parseStakeMeta(pre.get(a) ?? null); return w !== null && bytesEqual(w.withdrawer, me) })
    return new UnsafeTransactionError(`Transaction moves ${lost} lamports of stake out of this wallet's control${withdrawsFrom.size ? ' beyond what its Stake withdrawals pay to it' : ''}${hint}`, 'moves-lamports', where.length ? where : [...accounts])
  }
  return null
}

/** What one watched account is to this wallet, or undefined when it is not the wallet's. */
function kindOf(wallet: string, me: Uint8Array, addr: string, before: CustodyState | null, after: CustodyState | null, wrapped: ReadonlySet<string>, isTokenOwner: (owner: string) => boolean): SimulatedAccountChange['kind'] | undefined {
  if (addr === wallet) return 'wallet'
  if (wrapped.has(addr)) return 'wrapped-sol'
  for (const st of [before, after]) {
    if (!st) continue
    const t = isTokenOwner(st.owner) ? parseTokenAccount(st.data) : null
    if (t && bytesEqual(t.owner, me)) return 'token'
    const s = parseStakeMeta(st)
    if (s && (bytesEqual(s.withdrawer, me) || bytesEqual(s.staker, me))) return 'stake'
    const n = parseNonceAuthority(st)
    if (n && bytesEqual(n, me)) return 'nonce'
  }
  return undefined
}

/**
 * Every simulated change to an account of this wallet among `accounts`: lamports, token amounts,
 * closed or created accounts, a changed authority. What a review sheet lists next to the net balance
 * change, so nothing the simulation saw is left out.
 */
export function accountChanges(wallet: string, accounts: readonly string[], pre: States, post: States, wrapped: ReadonlySet<string>, isTokenOwner: (owner: string) => boolean): SimulatedAccountChange[] {
  const me = pubkeyBytes(wallet)
  const out: SimulatedAccountChange[] = []
  for (const addr of new Set(accounts)) {
    const before = pre.get(addr) ?? null
    const after = post.get(addr) ?? null
    const kind = kindOf(wallet, me, addr, before, after, wrapped, isTokenOwner)
    if (!kind) continue
    const lamportsBefore = before?.lamports ?? 0n
    const lamportsAfter = after?.lamports ?? 0n
    const change: SimulatedAccountChange = { address: addr, kind, lamportsBefore, lamportsAfter }
    if (kind === 'token' || kind === 'wrapped-sol') {
      const tb = before && isTokenOwner(before.owner) ? parseTokenAccount(before.data) : null
      const ta = after && isTokenOwner(after.owner) ? parseTokenAccount(after.data) : null
      const mintBytes = (ta ?? tb)?.mint
      if (mintBytes) change.mint = getAddressDecoder().decode(mintBytes)
      change.amountBefore = tb?.amount ?? 0n
      change.amountAfter = ta?.amount ?? 0n
    }
    if (before && (!after || after.lamports === 0n)) change.closed = true
    if (!before && after) change.created = true
    if (kind === 'stake' || kind === 'nonce') {
      const sb = parseStakeMeta(before)
      const sa = parseStakeMeta(after)
      const nb = parseNonceAuthority(before)
      const na = parseNonceAuthority(after)
      if ((sb && sa && (!bytesEqual(sb.staker, sa.staker) || !bytesEqual(sb.withdrawer, sa.withdrawer) || !bytesEqual(sb.lockup, sa.lockup))) || (nb && na && !bytesEqual(nb, na))) change.authorityChanged = true
    }
    const moved = lamportsBefore !== lamportsAfter || change.amountBefore !== change.amountAfter || change.closed || change.created || change.authorityChanged
    if (moved) out.push(change)
  }
  return out
}

