import { base58Decode, createWithSeed } from '../src/address.js'
import { STAKE_PROGRAM, SYSTEM_PROGRAM, SYSVAR_STAKE_HISTORY } from '../src/constants.js'

// An in-memory Solana node: just the RPC methods the module reads, with stake accounts encoded in
// the real `StakeStateV2` layout so the decoder runs on genuine bytes.

export const CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
export const WALLET = '8NDkBUK5TeK9a8wfzToa1phV2BTW5zA4DdXNvZKjHvWV'
export const OTHER = 'G1hEevirRDbcV25iD1Ghcqci6yq39ipat5dWgmbDFPg6'
export const V1 = 'CatzoSMUkTRidT5DwBxAC2pEtnwMBTpkCepHkFgZDiqb'
export const V2 = 'he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk'
export const V3 = 'GEM1N1pCDGKiTa547eckcwuHWYMsUQeXgnXHfEZLDvpB'
export const OUTSIDER = 'J1to5o1Q7W7Y2Q7zpETTezv3DyzPMHKDg66X2nZPMr4X'
export const SOL = 1_000_000_000n
export const RENT = 1_666_240n
export const EPOCH = 1068n
const MAX = 0xffff_ffff_ffff_ffffn

const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b }
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, v), true); return b }
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length } return out }
export const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

export interface StakeSpec {
  staker?: string
  withdrawer?: string
  voter?: string
  stake?: bigint
  activationEpoch?: bigint
  deactivationEpoch?: bigint
  lockup?: { unixTimestamp: bigint; epoch: bigint; custodian: string }
  initializedOnly?: boolean
}

/** A 200-byte `StakeStateV2` account, as the program writes it. */
export function encodeStakeAccount(s: StakeSpec): Uint8Array {
  const meta = cat(
    u64(2_282_880n), base58Decode(s.staker ?? WALLET), base58Decode(s.withdrawer ?? WALLET),
    u64(s.lockup?.unixTimestamp ?? 0n), u64(s.lockup?.epoch ?? 0n), base58Decode(s.lockup?.custodian ?? SYSTEM_PROGRAM),
  )
  const body = s.initializedOnly
    ? cat(u32(1), meta)
    : cat(u32(2), meta, base58Decode(s.voter ?? V1), u64(s.stake ?? SOL), u64(s.activationEpoch ?? EPOCH - 10n), u64(s.deactivationEpoch ?? MAX), u64(0n), u64(12345n), new Uint8Array([0]))
  const out = new Uint8Array(200)
  out.set(body)
  return out
}

/** The StakeHistory sysvar: u64 count, then (epoch, effective, activating, deactivating), newest first. */
export function encodeStakeHistory(entries: Array<[bigint, bigint, bigint, bigint]>): Uint8Array {
  return cat(u64(BigInt(entries.length)), ...entries.flatMap(([e, eff, act, de]) => [u64(e), u64(eff), u64(act), u64(de)]))
}

/** A calm cluster: 400M SOL effective, 1M SOL moving each way per epoch, for the last 20 epochs. */
export function calmHistory(upTo = EPOCH - 1n): Array<[bigint, bigint, bigint, bigint]> {
  return Array.from({ length: 20 }, (_, i) => [upTo - BigInt(i), 400_000_000n * SOL, 1_000_000n * SOL, 1_000_000n * SOL] as [bigint, bigint, bigint, bigint])
}

export interface Vote { votePubkey: string; nodePubkey: string; activatedStake: bigint; commission: number; lastVote: bigint; epochCredits: Array<[number, number, number]>; delinquent?: boolean }

export const VOTES: Vote[] = [
  { votePubkey: V1, nodePubkey: 'CatzoSMUkTRidT5DwBxAC2pEtnwMBTpkCepHkFgZDiqb', activatedStake: 900_000n * SOL, commission: 5, lastVote: 461_000_000n, epochCredits: [[1067, 800_000, 400_000], [1068, 801_000, 800_000]] },
  { votePubkey: V2, nodePubkey: 'he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk', activatedStake: 5_000_000n * SOL, commission: 0, lastVote: 461_000_000n, epochCredits: [[1068, 900, 0]] },
  { votePubkey: V3, nodePubkey: 'GEM1N1pCDGKiTa547eckcwuHWYMsUQeXgnXHfEZLDvpB', activatedStake: 100_000n * SOL, commission: 10, lastVote: 461_000_000n, epochCredits: [] },
  { votePubkey: OUTSIDER, nodePubkey: 'J1to5o1Q7W7Y2Q7zpETTezv3DyzPMHKDg66X2nZPMr4X', activatedStake: 10_000_000n * SOL, commission: 4, lastVote: 461_000_000n, epochCredits: [] },
]

export interface RawAccount { lamports: bigint; owner: string; data: Uint8Array }

export class FakeNode {
  epoch = EPOCH
  slotIndex = 216_000
  slotsInEpoch = 432_000
  rent = RENT
  minimumDelegation = SOL
  balance = 10n * SOL
  history = calmHistory()
  votes: Vote[] = VOTES.map((v) => ({ ...v }))
  accounts = new Map<string, RawAccount>()
  calls: Array<{ method: string; params: unknown[] }> = []
  rewards = new Map<string, bigint>()
  /** Methods that fail like an RPC that does not serve them. */
  refuse = new Set<string>()

  /** Puts a stake account in the wallet's seed slot `index`. Returns its address. */
  seedAccount(index: number, spec: StakeSpec, lamports?: bigint, prefix = 'stake:'): string {
    const address = createWithSeed(spec.staker === OTHER && spec.withdrawer === OTHER ? OTHER : WALLET, `${prefix}${index}`, STAKE_PROGRAM)
    this.accounts.set(address, { lamports: lamports ?? (spec.stake ?? SOL) + RENT, owner: STAKE_PROGRAM, data: encodeStakeAccount(spec) })
    return address
  }

  request = async (method: string, params: unknown[] = []): Promise<unknown> => {
    this.calls.push({ method, params })
    if (this.refuse.has(method)) throw Object.assign(new Error(`${method} is not available`), { code: -32601 })
    const acc = (a: string) => {
      if (a === SYSVAR_STAKE_HISTORY) return { lamports: 1n, owner: 'Sysvar1111111111111111111111111111111111111', data: [b64(encodeStakeHistory(this.history)), 'base64'] }
      const r = this.accounts.get(a)
      return r ? { lamports: Number(r.lamports), owner: r.owner, data: [b64(r.data), 'base64'], executable: false, space: r.data.length } : null
    }
    switch (method) {
      case 'getEpochInfo': return { epoch: Number(this.epoch), slotIndex: this.slotIndex, slotsInEpoch: this.slotsInEpoch, absoluteSlot: 461_000_000 }
      case 'getMinimumBalanceForRentExemption': return Number(this.rent)
      case 'getStakeMinimumDelegation': return { context: { slot: 1 }, value: Number(this.minimumDelegation) }
      case 'getAccountInfo': return { context: { slot: 1 }, value: acc(params[0] as string) }
      case 'getMultipleAccounts': return { context: { slot: 1 }, value: (params[0] as string[]).map(acc) }
      case 'getBalance': return { context: { slot: 1 }, value: Number(this.balance) }
      case 'getInflationRate': return { epoch: Number(this.epoch), foundation: 0, total: 0.0358, validator: 0.0358 }
      case 'getSupply': return { context: { slot: 1 }, value: { total: 620_000_000 * 1e9, circulating: 560_000_000 * 1e9, nonCirculating: 0, nonCirculatingAccounts: [] } }
      case 'getVoteAccounts': {
        const cfg = (params[0] ?? {}) as { votePubkey?: string }
        const rows = this.votes.filter((v) => !cfg.votePubkey || v.votePubkey === cfg.votePubkey).map(({ delinquent: _d, ...v }) => ({ ...v, activatedStake: Number(v.activatedStake), lastVote: Number(v.lastVote), epochVoteAccount: true, rootSlot: 1 }))
        return { current: rows.filter((r) => !this.votes.find((v) => v.votePubkey === r.votePubkey)?.delinquent), delinquent: rows.filter((r) => this.votes.find((v) => v.votePubkey === r.votePubkey)?.delinquent) }
      }
      case 'getProgramAccounts': {
        const cfg = params[1] as { filters: Array<{ memcmp?: { offset: number; bytes: string } }> }
        const m = cfg.filters.find((f) => f.memcmp)!.memcmp!
        const want = base58Decode(m.bytes)
        return [...this.accounts.entries()].filter(([, r]) => r.owner === STAKE_PROGRAM && want.every((b, i) => r.data[m.offset + i] === b)).map(([pubkey]) => ({ pubkey, account: acc(pubkey) }))
      }
      case 'getInflationReward': {
        const list = params[0] as string[]
        if (list.length > 32) throw Object.assign(new Error('Too many inputs provided; max 32'), { code: -32602 })
        return list.map((a) => (this.rewards.has(a) ? { epoch: (params[1] as { epoch: number }).epoch, effectiveSlot: 1, amount: Number(this.rewards.get(a)), postBalance: 2 * 1e9, commission: 5 } : null))
      }
      default: throw Object.assign(new Error(`FakeNode: no ${method}`), { code: -32601 })
    }
  }
}
