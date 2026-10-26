import { addressBytes, base58Encode } from './address.js'
import {
  COMPUTE_BUDGET_PROGRAM, STAKE_CONFIG, STAKE_PROGRAM, SYSTEM_PROGRAM, SYSVAR_CLOCK, SYSVAR_RENT, SYSVAR_STAKE_HISTORY, U64_MAX,
} from './constants.js'

// Hand-encoded System, Stake and Compute Budget instructions plus the stake-account and
// StakeHistory layouts. Layouts follow solana-program/stake (`StakeStateV2`, bincode) and use the
// legacy account lists (with sysvars), which every deployed version of the program accepts.

/** Account roles, numerically identical to `@solana/kit`'s `AccountRole`. */
export const READONLY = 0 as const
export const WRITABLE = 1 as const
export const READONLY_SIGNER = 2 as const
export const WRITABLE_SIGNER = 3 as const
export type Role = typeof READONLY | typeof WRITABLE | typeof READONLY_SIGNER | typeof WRITABLE_SIGNER

/** One account of an instruction. */
export interface AccountMeta { address: string; role: Role }
/** An instruction in the shape `@solana/kit` transaction messages carry (what `wallet-solana` signs). */
export interface Instruction { programAddress: string; accounts: AccountMeta[]; data: Uint8Array }

/** Stake program instruction tags (`StakeInstruction`, bincode u32). */
export const STAKE_IX = { initialize: 0, authorize: 1, delegate: 2, split: 3, withdraw: 4, deactivate: 5, setLockup: 6, merge: 7, initializeChecked: 9, deactivateDelinquent: 14, moveStake: 16, moveLamports: 17 } as const

class Writer {
  private readonly parts: number[] = []
  u8(v: number): this { this.parts.push(v & 0xff); return this }
  u32(v: number): this { for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 0xff); return this }
  u64(v: bigint): this {
    if (v < 0n || v > U64_MAX) throw new RangeError(`u64 out of range: ${v}`)
    for (let i = 0n; i < 8n; i++) this.parts.push(Number((v >> (8n * i)) & 0xffn))
    return this
  }
  i64(v: bigint): this { return this.u64(BigInt.asUintN(64, v)) }
  address(a: string): this { for (const b of addressBytes(a)) this.parts.push(b); return this }
  bytes(b: Uint8Array): this { for (const x of b) this.parts.push(x); return this }
  build(): Uint8Array { return Uint8Array.from(this.parts) }
}

class Reader {
  private readonly view: DataView
  private at = 0
  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }
  private need(n: number): void {
    if (this.at + n > this.data.length) throw new RangeError(`Account data too short: need ${this.at + n} bytes, have ${this.data.length}.`)
  }
  u8(): number { this.need(1); return this.data[this.at++]! }
  u32(): number { this.need(4); const v = this.view.getUint32(this.at, true); this.at += 4; return v }
  u64(): bigint { this.need(8); const v = this.view.getBigUint64(this.at, true); this.at += 8; return v }
  i64(): bigint { this.need(8); const v = this.view.getBigInt64(this.at, true); this.at += 8; return v }
  address(): string { this.need(32); const v = base58Encode(this.data.subarray(this.at, this.at + 32)); this.at += 32; return v }
  skip(n: number): void { this.need(n); this.at += n }
}

const meta = (address: string, role: Role): AccountMeta => ({ address, role })

// ── Instructions ──────────────────────────────────────────────────────────────

/** System `CreateAccountWithSeed` (3). `base` signs; when it is the payer it is listed once. */
export function ixCreateAccountWithSeed(p: { payer: string; newAccount: string; base: string; seed: string; lamports: bigint; space: number; owner: string }): Instruction {
  const accounts = [meta(p.payer, WRITABLE_SIGNER), meta(p.newAccount, WRITABLE)]
  if (p.base !== p.payer) accounts.push(meta(p.base, READONLY_SIGNER))
  const seed = new TextEncoder().encode(p.seed)
  const data = new Writer().u32(3).address(p.base).u64(BigInt(seed.length)).bytes(seed).u64(p.lamports).u64(BigInt(p.space)).address(p.owner).build()
  return { programAddress: SYSTEM_PROGRAM, accounts, data }
}

/** System `Transfer` (2). Accounts: [from WS, to W]. */
export function ixTransfer(p: { from: string; to: string; lamports: bigint }): Instruction {
  return { programAddress: SYSTEM_PROGRAM, accounts: [meta(p.from, WRITABLE_SIGNER), meta(p.to, WRITABLE)], data: new Writer().u32(2).u64(p.lamports).build() }
}

/**
 * System `AllocateWithSeed` (9): gives an existing, data-less System account at a seed address its
 * space and owner. Used when someone sent SOL to a seed address before the wallet created it there.
 * Accounts: [account W, base S].
 */
export function ixAllocateWithSeed(p: { account: string; base: string; seed: string; space: number; owner: string }): Instruction {
  const seed = new TextEncoder().encode(p.seed)
  const data = new Writer().u32(9).address(p.base).u64(BigInt(seed.length)).bytes(seed).u64(BigInt(p.space)).address(p.owner).build()
  return { programAddress: SYSTEM_PROGRAM, accounts: [meta(p.account, WRITABLE), meta(p.base, READONLY_SIGNER)], data }
}

/** Stake `Initialize` (0): authorities set, no lockup. Accounts: [stake W, rent]. */
export function ixInitialize(p: { stake: string; staker: string; withdrawer: string }): Instruction {
  const data = new Writer().u32(STAKE_IX.initialize).address(p.staker).address(p.withdrawer)
    .i64(0n).u64(0n).address(SYSTEM_PROGRAM) // Lockup { unix_timestamp: 0, epoch: 0, custodian: default }
    .build()
  return { programAddress: STAKE_PROGRAM, accounts: [meta(p.stake, WRITABLE), meta(SYSVAR_RENT, READONLY)], data }
}

/** Stake `DelegateStake` (2). Accounts: [stake W, vote, clock, stake history, stake config, stake authority S]. */
export function ixDelegate(p: { stake: string; vote: string; authority: string }): Instruction {
  return {
    programAddress: STAKE_PROGRAM,
    accounts: [meta(p.stake, WRITABLE), meta(p.vote, READONLY), meta(SYSVAR_CLOCK, READONLY), meta(SYSVAR_STAKE_HISTORY, READONLY), meta(STAKE_CONFIG, READONLY), meta(p.authority, READONLY_SIGNER)],
    data: new Writer().u32(STAKE_IX.delegate).build(),
  }
}

/** Stake `Split` (3). Accounts: [source W, destination W, stake authority S]. */
export function ixSplit(p: { stake: string; splitStake: string; authority: string; lamports: bigint }): Instruction {
  return {
    programAddress: STAKE_PROGRAM,
    accounts: [meta(p.stake, WRITABLE), meta(p.splitStake, WRITABLE), meta(p.authority, READONLY_SIGNER)],
    data: new Writer().u32(STAKE_IX.split).u64(p.lamports).build(),
  }
}

/** Stake `Withdraw` (4). Accounts: [stake W, recipient W, clock, stake history, withdraw authority S]. */
export function ixWithdraw(p: { stake: string; recipient: string; authority: string; lamports: bigint }): Instruction {
  return {
    programAddress: STAKE_PROGRAM,
    accounts: [meta(p.stake, WRITABLE), meta(p.recipient, WRITABLE), meta(SYSVAR_CLOCK, READONLY), meta(SYSVAR_STAKE_HISTORY, READONLY), meta(p.authority, READONLY_SIGNER)],
    data: new Writer().u32(STAKE_IX.withdraw).u64(p.lamports).build(),
  }
}

/** Stake `Deactivate` (5). Accounts: [stake W, clock, stake authority S]. */
export function ixDeactivate(p: { stake: string; authority: string }): Instruction {
  return {
    programAddress: STAKE_PROGRAM,
    accounts: [meta(p.stake, WRITABLE), meta(SYSVAR_CLOCK, READONLY), meta(p.authority, READONLY_SIGNER)],
    data: new Writer().u32(STAKE_IX.deactivate).build(),
  }
}

/** Stake `Merge` (7): `source` is drained into `destination`. Accounts: [destination W, source W, clock, stake history, stake authority S]. */
export function ixMerge(p: { destination: string; source: string; authority: string }): Instruction {
  return {
    programAddress: STAKE_PROGRAM,
    accounts: [meta(p.destination, WRITABLE), meta(p.source, WRITABLE), meta(SYSVAR_CLOCK, READONLY), meta(SYSVAR_STAKE_HISTORY, READONLY), meta(p.authority, READONLY_SIGNER)],
    data: new Writer().u32(STAKE_IX.merge).build(),
  }
}

/** Compute Budget `SetComputeUnitLimit` (2). */
export function ixSetComputeUnitLimit(units: number): Instruction {
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: new Writer().u8(2).u32(units).build() }
}

/** Compute Budget `SetComputeUnitPrice` (3), micro-lamports per unit. */
export function ixSetComputeUnitPrice(microLamports: bigint): Instruction {
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: new Writer().u8(3).u64(microLamports).build() }
}

// ── Account layouts ─────────────────────────────────────────────────────────

/** `StakeStateV2` tag. */
export type StakeAccountKind = 'uninitialized' | 'initialized' | 'delegated' | 'rewardsPool'

/** A stake delegation. `deactivationEpoch` is u64::MAX while delegated; `activationEpoch` u64::MAX marks a bootstrap stake. */
export interface Delegation { voter: string; stake: bigint; activationEpoch: bigint; deactivationEpoch: bigint }

/** Decoded stake account. */
export interface StakeAccountData {
  kind: StakeAccountKind
  rentExemptReserve: bigint
  staker: string | null
  withdrawer: string | null
  /** `unixTimestamp` / `epoch` are 0 and `custodian` the default address when no lockup was set. */
  lockup: { unixTimestamp: bigint; epoch: bigint; custodian: string } | null
  delegation: Delegation | null
  creditsObserved: bigint | null
}

/** Decodes a stake account (bincode `StakeStateV2`: u32 tag, `Meta`, then `Stake` and flags for tag 2). */
export function decodeStakeAccount(data: Uint8Array): StakeAccountData {
  const r = new Reader(data)
  const tag = r.u32()
  const kind: StakeAccountKind = (['uninitialized', 'initialized', 'delegated', 'rewardsPool'] as const)[tag] ?? 'uninitialized'
  const empty: StakeAccountData = { kind, rentExemptReserve: 0n, staker: null, withdrawer: null, lockup: null, delegation: null, creditsObserved: null }
  if (tag !== 1 && tag !== 2) return empty
  const rentExemptReserve = r.u64()
  const staker = r.address()
  const withdrawer = r.address()
  const lockup = { unixTimestamp: r.i64(), epoch: r.u64(), custodian: r.address() }
  if (tag === 1) return { ...empty, rentExemptReserve, staker, withdrawer, lockup }
  const voter = r.address()
  const stake = r.u64()
  const activationEpoch = r.u64()
  const deactivationEpoch = r.u64()
  r.skip(8) // warmup_cooldown_rate (deprecated f64)
  const creditsObserved = r.u64()
  return { kind, rentExemptReserve, staker, withdrawer, lockup, delegation: { voter, stake, activationEpoch, deactivationEpoch }, creditsObserved }
}

/** Is a lockup still in force at `epoch` / `unixTime` (seconds)? A lockup binds withdrawals and withdraw-authority changes. */
export function lockupInForce(lockup: StakeAccountData['lockup'], epoch: bigint, unixTime: bigint): boolean {
  if (!lockup) return false
  return lockup.unixTimestamp > unixTime || lockup.epoch > epoch
}

/** One epoch of the cluster's stake (lamports). */
export interface ClusterStake { effective: bigint; activating: bigint; deactivating: bigint }

/** Decodes the StakeHistory sysvar: `Vec<(Epoch, StakeHistoryEntry)>`, newest first. */
export function decodeStakeHistory(data: Uint8Array): Map<bigint, ClusterStake> {
  const r = new Reader(data)
  const n = r.u64()
  const out = new Map<bigint, ClusterStake>()
  for (let i = 0n; i < n; i++) {
    const epoch = r.u64()
    out.set(epoch, { effective: r.u64(), activating: r.u64(), deactivating: r.u64() })
  }
  return out
}

/** Decodes the u32 tag of a stake instruction's data, or null. */
export function stakeInstructionTag(data: Uint8Array): number | null {
  if (data.length < 4) return null
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true)
}
