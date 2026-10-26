import { activityBase, netTransfers, splitNet, type ActivityItem, type ChainTx, type DescribeActivityContext } from '@anywalletkit/core'
import { base58Decode } from './address.js'
import { STAKE_IX, stakeInstructionTag } from './codec.js'
import { COMPUTE_BUDGET_PROGRAM, STAKE_PROGRAM, SYSTEM_PROGRAM } from './constants.js'
import type { ValidatorConfig } from './validators.js'

// Activity recognition for native staking: pure and offline.
//
// A transaction is this module's when the Stake program is the first program it calls that is not
// plumbing (`call.to`; System, Compute Budget and the token programs are plumbing). What it did comes
// from, in order: the jsonParsed instructions a Solana history source keeps in `raw.tx`, the first
// Stake instruction's tag in `call.data` (base58), and finally the SOL movement. Create + Initialize +
// Delegate → stake; Deactivate (after a Split or not) → unstake; Withdraw → claim; Delegate alone →
// delegate (re-delegation or an undone unstake); Merge → merge. Stake pools are not matched: they call
// their own program first.

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@anywalletkit/protocol-staking-native-solana'

type Action = 'stake' | 'unstake' | 'claim' | 'delegate' | 'merge' | 'other'

const TITLES: Record<Action, { kind: ActivityItem['kind']; title: string }> = {
  stake: { kind: 'stake', title: 'Staked SOL' },
  unstake: { kind: 'unstake', title: 'Requested unstake' },
  claim: { kind: 'claim', title: 'Withdrew unstaked SOL' },
  delegate: { kind: 'stake', title: 'Delegated stake' },
  merge: { kind: 'stake', title: 'Merged stake accounts' },
  other: { kind: 'contract', title: 'Stake account update' },
}

interface ParsedIx { program?: string; programId?: string; parsed?: { type?: string; info?: Record<string, unknown> } }

/** Top-level parsed Stake instructions of a jsonParsed transaction kept in `raw.tx`, or null when the source kept none. */
function parsedStakeInstructions(tx: ChainTx): ParsedIx[] | null {
  const raw = tx.raw as { tx?: { transaction?: { message?: { instructions?: unknown[] } } } } | undefined
  const list = raw?.tx?.transaction?.message?.instructions
  if (!Array.isArray(list)) return null
  const stake = (list as ParsedIx[]).filter((ix) => ix && (ix.programId === STAKE_PROGRAM || ix.program === 'stake') && typeof ix.parsed?.type === 'string')
  return stake.length > 0 ? stake : null
}

function fromParsed(ixs: ParsedIx[]): { action: Action; vote: string | null } {
  const types = new Set(ixs.map((ix) => ix.parsed!.type!))
  const delegate = ixs.find((ix) => ix.parsed!.type === 'delegate')
  const vote = typeof delegate?.parsed?.info?.voteAccount === 'string' ? delegate.parsed.info.voteAccount : null
  if (delegate && (types.has('initialize') || types.has('initializeChecked'))) return { action: 'stake', vote }
  if (types.has('withdraw')) return { action: 'claim', vote: null }
  if (types.has('deactivate') || types.has('deactivateDelinquent')) return { action: 'unstake', vote: null }
  if (delegate) return { action: 'delegate', vote }
  if (types.has('merge')) return { action: 'merge', vote: null }
  return { action: 'other', vote: null }
}

function fromTag(tag: number | null): Action | null {
  switch (tag) {
    case STAKE_IX.initialize: case STAKE_IX.initializeChecked: return 'stake'
    case STAKE_IX.withdraw: return 'claim'
    case STAKE_IX.deactivate: case STAKE_IX.split: case STAKE_IX.deactivateDelinquent: return 'unstake'
    case STAKE_IX.delegate: return 'delegate'
    case STAKE_IX.merge: return 'merge'
    case null: return null
    default: return 'other'
  }
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

/** Programs a native-staking transaction may also touch; anything else (a stake pool, a router) makes it someone else's. */
const OWN_PROGRAMS = new Set([STAKE_PROGRAM, SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM, 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'])

/** Describes a native-staking transaction for the wallet's feed, or returns null when it is not one. */
export function describeNativeStakeActivity(tx: ChainTx, ctx: DescribeActivityContext, validators: readonly ValidatorConfig[] = []): ActivityItem | null {
  if (!tx.chain.startsWith('solana:')) return null
  const call = tx.call
  if (!call || call.to !== STAKE_PROGRAM) return null
  // A stake pool's DepositStake authorizes the pool with Stake instructions first: call.to is Stake, but it is the pool's.
  if ((call.programs ?? []).some((p) => !OWN_PROGRAMS.has(p))) return null

  const { assetsIn, assetsOut } = splitNet(netTransfers(tx, ctx.own), (token) => (token === null ? { symbol: 'SOL', decimals: 9 } : undefined))
  let action: Action | null = null
  let vote: string | null = null
  const parsed = parsedStakeInstructions(tx)
  if (parsed) ({ action, vote } = fromParsed(parsed))
  if (action === null && typeof call.data === 'string' && call.data.length > 0) {
    try { action = fromTag(stakeInstructionTag(base58Decode(call.data))) } catch { action = null }
    // A Split is an unstake only with the Deactivate that follows it (one more Stake instruction).
    if (action === 'unstake' && stakeInstructionTag(base58Decode(call.data)) === STAKE_IX.split && (call.programs ?? []).filter((p) => p === STAKE_PROGRAM).length < 2) action = 'other'
  }
  if (action === null) {
    const solIn = assetsIn.some((a) => a.token === null)
    const solOut = assetsOut.some((a) => a.token === null)
    action = solIn && !solOut ? 'claim' : solOut && !solIn ? 'stake' : 'other'
  }

  const { kind, title } = TITLES[action]
  const name = vote ? validators.find((v) => v.voteAccount === vote)?.name ?? short(vote) : null
  return activityBase(tx, kind, title, {
    protocol: MODULE_NAME,
    subtitle: name ? `Native staking · ${name}` : 'Native staking · Solana',
    counterparty: vote ?? STAKE_PROGRAM,
    assetsIn,
    assetsOut,
  })
}
