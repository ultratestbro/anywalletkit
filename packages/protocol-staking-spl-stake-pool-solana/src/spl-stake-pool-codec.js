'use strict'

// SPL Stake Pool mechanics that are pure over bytes — no network, no wallet.
//
//  - decoders for the pool state (borsh), the validator list (POD) and stake
//    accounts (bincode StakeStateV2), layouts checked against the
//    solana-program/stake-pool and solana-program/stake sources (2026-09-07);
//  - the pool's own arithmetic (pool tokens ⇄ lamports, Fee::apply), so quotes
//    match what the program does to the lamport;
//  - encoders for the instructions a wallet needs: Stake Pool DepositSol(14) /
//    WithdrawStake(10) / WithdrawSol(16) and the ..WithSlippage variants
//    (25 / 24 / 26), System CreateAccountWithSeed(3), Stake Deactivate(5) /
//    Withdraw(4), the Associated Token idempotent create and the compute
//    budget pair. Written out here rather than pulled from an SDK: the
//    Solana wallet is built on @solana/* 3.x, the published stake-pool client
//    wants web3.js v1 and @solana-program/stake wants kit ≥5 — a second kit
//    copy is exactly what a mobile bundle must not carry;
//  - the withdraw-source selection the program enforces (preferred validator
//    first, then any validator stake account that keeps its minimum, the
//    reserve only when no validator holds stake).

import {
  createAddressWithSeed,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress
} from '@solana/addresses'
import { AccountRole } from '@solana/instructions'

/** @typedef {import('@solana/addresses').Address} Address */
/** @typedef {import('@solana/instructions').Instruction} Instruction */

export const STAKE_POOL_PROGRAM = /** @type {Address} */ ('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy')
export const STAKE_PROGRAM = /** @type {Address} */ ('Stake11111111111111111111111111111111111111')
export const SYSTEM_PROGRAM = /** @type {Address} */ ('11111111111111111111111111111111')
export const TOKEN_PROGRAM = /** @type {Address} */ ('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ATA_PROGRAM = /** @type {Address} */ ('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const COMPUTE_BUDGET_PROGRAM = /** @type {Address} */ ('ComputeBudget111111111111111111111111111111')
export const SYSVAR_CLOCK = /** @type {Address} */ ('SysvarC1ock11111111111111111111111111111111')
export const SYSVAR_STAKE_HISTORY = /** @type {Address} */ ('SysvarStakeHistory1111111111111111111111111')
/** Size of a stake account; its rent comes from `getMinimumBalanceForRentExemption(200)`. */
export const STAKE_ACCOUNT_SPACE = 200
/** The stake pool program's own floor for an active validator stake (`MINIMUM_ACTIVE_STAKE`). */
export const POOL_MINIMUM_ACTIVE_STAKE = 1_000_000n
const U64_MAX = 0xffffffffffffffffn
const LAMPORTS_PER_SOL = 1_000_000_000n

/* ------------------------------------------------------------------------ */
/* Bytes                                                                    */
/* ------------------------------------------------------------------------ */

const addressEncoder = getAddressEncoder()
const addressDecoder = getAddressDecoder()

/**
 * @param {string} address - A base58 address.
 * @returns {Uint8Array} Its 32 bytes.
 */
export function addressToBytes (address) {
  return new Uint8Array(addressEncoder.encode(/** @type {Address} */ (address)))
}

/**
 * @param {Uint8Array} bytes - 32 bytes.
 * @returns {Address} The base58 address.
 */
export function bytesToAddress (bytes) {
  return addressDecoder.decode(bytes)
}

class Reader {
  /** @param {Uint8Array} bytes - The buffer. */
  constructor (bytes) {
    this.b = bytes
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.o = 0
  }

  u8 () { const x = this.v.getUint8(this.o); this.o += 1; return x }
  u32 () { const x = this.v.getUint32(this.o, true); this.o += 4; return x }
  u64 () { const x = this.v.getBigUint64(this.o, true); this.o += 8; return x }
  i64 () { const x = this.v.getBigInt64(this.o, true); this.o += 8; return x }
  f64 () { const x = this.v.getFloat64(this.o, true); this.o += 8; return x }
  address () { const x = bytesToAddress(this.b.subarray(this.o, this.o + 32)); this.o += 32; return x }
}

class Writer {
  constructor () { /** @type {Uint8Array[]} */ this.parts = [] }
  /** @param {number} x */
  u8 (x) { this.parts.push(Uint8Array.of(x)); return this }
  /** @param {number} x */
  u32 (x) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, x, true); this.parts.push(b); return this }
  /** @param {bigint} x */
  u64 (x) {
    if (x < 0n || x > U64_MAX) throw new Error('u64 out of range')
    const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, x, true); this.parts.push(b); return this
  }

  /** @param {Uint8Array} b */
  bytes (b) { this.parts.push(b); return this }
  /** @param {string} a */
  address (a) { return this.bytes(addressToBytes(a)) }
  /** bincode string: u64 length + utf-8 bytes. @param {string} s */
  bincodeString (s) { const b = new TextEncoder().encode(s); return this.u64(BigInt(b.length)).bytes(b) }
  build () {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of this.parts) { out.set(p, o); o += p.length }
    return out
  }
}

/* ------------------------------------------------------------------------ */
/* State decoders                                                           */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {Object} PoolFee
 * @property {bigint} denominator
 * @property {bigint} numerator
 */

/**
 * `Fee::apply`: 0 when the denominator is 0, else amount × n / d (floor).
 *
 * @param {PoolFee} fee - The fee.
 * @param {bigint} amount - The amount it applies to.
 * @returns {bigint} The fee amount.
 */
export function applyFee (fee, amount) {
  return fee.denominator === 0n ? 0n : (amount * fee.numerator) / fee.denominator
}

/**
 * @param {PoolFee} fee - The fee.
 * @returns {number} The fee as a percentage.
 */
export function feePercent (fee) {
  return fee.denominator === 0n ? 0 : (Number(fee.numerator) * 100) / Number(fee.denominator)
}

/**
 * @typedef {Object} StakePoolState
 * @property {Address} manager
 * @property {Address} staker
 * @property {Address} stakeDepositAuthority
 * @property {Address} validatorList
 * @property {Address} reserveStake
 * @property {Address} poolMint
 * @property {Address} managerFeeAccount
 * @property {Address} tokenProgram
 * @property {bigint} totalLamports
 * @property {bigint} poolTokenSupply
 * @property {bigint} lastUpdateEpoch
 * @property {PoolFee} epochFee
 * @property {Address | null} preferredDepositValidator
 * @property {Address | null} preferredWithdrawValidator
 * @property {PoolFee} stakeDepositFee
 * @property {PoolFee} stakeWithdrawalFee
 * @property {number} stakeReferralFee
 * @property {Address | null} solDepositAuthority
 * @property {PoolFee} solDepositFee
 * @property {number} solReferralFee
 * @property {Address | null} solWithdrawAuthority
 * @property {PoolFee} solWithdrawalFee
 * @property {bigint} lastEpochPoolTokenSupply
 * @property {bigint} lastEpochTotalLamports
 */

/**
 * Decodes a `StakePool` account (borsh, account_type 1).
 *
 * @param {Uint8Array} data - The account data.
 * @returns {StakePoolState} The pool state.
 */
export function decodeStakePool (data) {
  const r = new Reader(data)
  const accountType = r.u8()
  if (accountType !== 1) throw new Error(`spl-stake-pool: not a stake pool account (type ${accountType})`)
  const fee = () => ({ denominator: r.u64(), numerator: r.u64() })
  const futureFee = () => { if (r.u8() !== 0) fee() }
  const optAddress = () => (r.u8() ? r.address() : null)

  const manager = r.address()
  const staker = r.address()
  const stakeDepositAuthority = r.address()
  r.u8() // stake_withdraw_bump_seed
  const validatorList = r.address()
  const reserveStake = r.address()
  const poolMint = r.address()
  const managerFeeAccount = r.address()
  const tokenProgram = r.address()
  const totalLamports = r.u64()
  const poolTokenSupply = r.u64()
  const lastUpdateEpoch = r.u64()
  r.i64(); r.u64(); r.address() // lockup
  const epochFee = fee()
  futureFee() // next_epoch_fee
  const preferredDepositValidator = optAddress()
  const preferredWithdrawValidator = optAddress()
  const stakeDepositFee = fee()
  const stakeWithdrawalFee = fee()
  futureFee() // next_stake_withdrawal_fee
  const stakeReferralFee = r.u8()
  const solDepositAuthority = optAddress()
  const solDepositFee = fee()
  const solReferralFee = r.u8()
  const solWithdrawAuthority = optAddress()
  const solWithdrawalFee = fee()
  futureFee() // next_sol_withdrawal_fee
  const lastEpochPoolTokenSupply = r.u64()
  const lastEpochTotalLamports = r.u64()
  return {
    manager,
    staker,
    stakeDepositAuthority,
    validatorList,
    reserveStake,
    poolMint,
    managerFeeAccount,
    tokenProgram,
    totalLamports,
    poolTokenSupply,
    lastUpdateEpoch,
    epochFee,
    preferredDepositValidator,
    preferredWithdrawValidator,
    stakeDepositFee,
    stakeWithdrawalFee,
    stakeReferralFee,
    solDepositAuthority,
    solDepositFee,
    solReferralFee,
    solWithdrawAuthority,
    solWithdrawalFee,
    lastEpochPoolTokenSupply,
    lastEpochTotalLamports
  }
}

/** @typedef {'active' | 'deactivatingTransient' | 'readyForRemoval' | 'deactivatingValidator' | 'deactivatingAll'} ValidatorStatus */
const VALIDATOR_STATUS = /** @type {ValidatorStatus[]} */ (['active', 'deactivatingTransient', 'readyForRemoval', 'deactivatingValidator', 'deactivatingAll'])

/**
 * @typedef {Object} ValidatorStakeInfo
 * @property {bigint} activeStakeLamports - Lamports on the validator stake account (stake + rent) as of the last update.
 * @property {bigint} transientStakeLamports
 * @property {bigint} lastUpdateEpoch
 * @property {bigint} transientSeedSuffix
 * @property {number} validatorSeedSuffix
 * @property {ValidatorStatus} status
 * @property {Address} voteAccount
 */

/**
 * Decodes a `ValidatorList` account: 5-byte header, u32 count, 73-byte POD entries.
 *
 * @param {Uint8Array} data - The account data (a prefix holding N whole entries is enough).
 * @returns {{ maxValidators: number, validators: ValidatorStakeInfo[] }} The list.
 */
export function decodeValidatorList (data) {
  const r = new Reader(data)
  const accountType = r.u8()
  if (accountType !== 2) throw new Error(`spl-stake-pool: not a validator list account (type ${accountType})`)
  const maxValidators = r.u32()
  const count = r.u32()
  const validators = []
  for (let i = 0; i < count && r.o + 73 <= data.length; i++) {
    const activeStakeLamports = r.u64()
    const transientStakeLamports = r.u64()
    const lastUpdateEpoch = r.u64()
    const transientSeedSuffix = r.u64()
    r.u32() // unused
    const validatorSeedSuffix = r.u32()
    const status = VALIDATOR_STATUS[r.u8()] ?? 'active'
    const voteAccount = r.address()
    validators.push({ activeStakeLamports, transientStakeLamports, lastUpdateEpoch, transientSeedSuffix, validatorSeedSuffix, status, voteAccount })
  }
  return { maxValidators, validators }
}

/**
 * @typedef {Object} StakeAccountData
 * @property {'uninitialized' | 'initialized' | 'stake' | 'rewardsPool'} state
 * @property {bigint} rentExemptReserve
 * @property {Address | null} staker
 * @property {Address | null} withdrawer
 * @property {{ voter: Address, stake: bigint, activationEpoch: bigint, deactivationEpoch: bigint } | null} delegation - Present for `state === 'stake'`; `deactivationEpoch` is u64::MAX while delegated.
 */

/**
 * Decodes a stake account (bincode `StakeStateV2`: u32 tag, Meta, then Stake for tag 2).
 *
 * @param {Uint8Array} data - The account data.
 * @returns {StakeAccountData} The stake account.
 */
export function decodeStakeAccount (data) {
  const r = new Reader(data)
  const tag = r.u32()
  const state = /** @type {StakeAccountData['state']} */ (['uninitialized', 'initialized', 'stake', 'rewardsPool'][tag] ?? 'uninitialized')
  if (tag !== 1 && tag !== 2) return { state, rentExemptReserve: 0n, staker: null, withdrawer: null, delegation: null }
  const rentExemptReserve = r.u64()
  const staker = r.address()
  const withdrawer = r.address()
  r.i64(); r.u64(); r.address() // lockup
  if (tag === 1) return { state, rentExemptReserve, staker, withdrawer, delegation: null }
  const voter = r.address()
  const stake = r.u64()
  const activationEpoch = r.u64()
  const deactivationEpoch = r.u64()
  r.f64() // warmup_cooldown_rate
  return { state, rentExemptReserve, staker, withdrawer, delegation: { voter, stake, activationEpoch, deactivationEpoch } }
}

/** @typedef {'inactive' | 'activating' | 'active' | 'deactivating'} StakeActivation */

/**
 * Activation status from the delegation epochs alone — exact for the amounts
 * a wallet moves (the network-wide warm-up / cool-down rate only stretches
 * over several epochs when a large share of all stake moves at once).
 *
 * @param {StakeAccountData} account - The decoded stake account.
 * @param {bigint} epoch - The current epoch.
 * @returns {StakeActivation} The status.
 */
export function stakeActivation (account, epoch) {
  const d = account.delegation
  if (!d) return 'inactive'
  if (d.deactivationEpoch !== U64_MAX) return epoch > d.deactivationEpoch ? 'inactive' : 'deactivating'
  return epoch > d.activationEpoch ? 'active' : 'activating'
}

/* ------------------------------------------------------------------------ */
/* Pool arithmetic                                                          */
/* ------------------------------------------------------------------------ */

/**
 * `calc_pool_tokens_for_deposit` — pool tokens minted for a lamport deposit, before fees.
 *
 * @param {{ totalLamports: bigint, poolTokenSupply: bigint }} pool - Pool totals.
 * @param {bigint} lamports - The deposit.
 * @returns {bigint} Pool tokens.
 */
export function poolTokensForLamports (pool, lamports) {
  if (pool.totalLamports === 0n || pool.poolTokenSupply === 0n) return lamports
  return (lamports * pool.poolTokenSupply) / pool.totalLamports
}

/**
 * `calc_lamports_withdraw_amount` — lamports a pool-token amount redeems for.
 *
 * @param {{ totalLamports: bigint, poolTokenSupply: bigint }} pool - Pool totals.
 * @param {bigint} poolTokens - Pool tokens.
 * @returns {bigint} Lamports.
 */
export function lamportsForPoolTokens (pool, poolTokens) {
  if (pool.poolTokenSupply === 0n) return 0n
  return (poolTokens * pool.totalLamports) / pool.poolTokenSupply
}

/**
 * Lamports per 1e9 pool tokens — the LST "rate", 1e9 fixed point.
 *
 * @param {{ totalLamports: bigint, poolTokenSupply: bigint }} pool - Pool totals.
 * @returns {bigint} The rate.
 */
export function poolRate (pool) {
  return pool.poolTokenSupply === 0n ? LAMPORTS_PER_SOL : (pool.totalLamports * LAMPORTS_PER_SOL) / pool.poolTokenSupply
}

/**
 * What a SOL deposit yields after the pool's SOL deposit fee.
 *
 * @param {StakePoolState} pool - The pool state.
 * @param {bigint} lamports - The deposit.
 * @returns {{ poolTokens: bigint, feeTokens: bigint }} Tokens to the depositor and to the manager.
 */
export function quoteDepositSol (pool, lamports) {
  const gross = poolTokensForLamports(pool, lamports)
  const feeTokens = applyFee(pool.solDepositFee, gross)
  return { poolTokens: gross - feeTokens, feeTokens }
}

/**
 * What burning pool tokens through `WithdrawSol` pays, after the SOL withdrawal fee.
 *
 * @param {StakePoolState} pool - The pool state.
 * @param {bigint} poolTokens - Pool tokens to burn.
 * @returns {{ lamports: bigint, feeTokens: bigint, burnt: bigint }} The quote.
 */
export function quoteWithdrawSol (pool, poolTokens) {
  const feeTokens = applyFee(pool.solWithdrawalFee, poolTokens)
  const burnt = poolTokens - feeTokens
  return { lamports: lamportsForPoolTokens(pool, burnt), feeTokens, burnt }
}

/**
 * What burning pool tokens through `WithdrawStake` puts into the new stake account, after the stake withdrawal fee.
 *
 * @param {StakePoolState} pool - The pool state.
 * @param {bigint} poolTokens - Pool tokens to burn.
 * @returns {{ lamports: bigint, feeTokens: bigint, burnt: bigint }} The quote.
 */
export function quoteWithdrawStake (pool, poolTokens) {
  const feeTokens = applyFee(pool.stakeWithdrawalFee, poolTokens)
  const burnt = poolTokens - feeTokens
  return { lamports: lamportsForPoolTokens(pool, burnt), feeTokens, burnt }
}

/**
 * `minimum_stake_lamports`: rent + max(stake program minimum delegation, pool floor).
 *
 * @param {bigint} rentExempt - Rent-exempt minimum for a stake account.
 * @param {bigint} minimumDelegation - The stake program's minimum delegation.
 * @returns {bigint} Lamports.
 */
export function minimumStakeLamports (rentExempt, minimumDelegation) {
  return rentExempt + (minimumDelegation > POOL_MINIMUM_ACTIVE_STAKE ? minimumDelegation : POOL_MINIMUM_ACTIVE_STAKE)
}

/* ------------------------------------------------------------------------ */
/* Addresses                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The pool's withdraw authority PDA: `[pool, "withdraw"]`.
 *
 * @param {string} pool - The pool address.
 * @returns {Promise<Address>} The PDA.
 */
export async function findWithdrawAuthority (pool) {
  const [pda] = await getProgramDerivedAddress({ programAddress: STAKE_POOL_PROGRAM, seeds: [addressToBytes(pool), 'withdraw'] })
  return pda
}

/**
 * A validator's stake account PDA: `[vote, pool, (u32 LE seed suffix when non-zero)]`.
 *
 * @param {string} pool - The pool address.
 * @param {string} voteAccount - The validator vote account.
 * @param {number} seedSuffix - `validatorSeedSuffix` from the list entry.
 * @returns {Promise<Address>} The PDA.
 */
export async function findValidatorStakeAccount (pool, voteAccount, seedSuffix) {
  const seeds = [addressToBytes(voteAccount), addressToBytes(pool)]
  if (seedSuffix !== 0) seeds.push(new Writer().u32(seedSuffix).build())
  const [pda] = await getProgramDerivedAddress({ programAddress: STAKE_POOL_PROGRAM, seeds })
  return pda
}

/**
 * The associated token account for `mint` owned by `owner` (classic Token program).
 *
 * @param {string} owner - The wallet.
 * @param {string} mint - The mint.
 * @returns {Promise<Address>} The ATA.
 */
export async function findAta (owner, mint) {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [addressToBytes(owner), addressToBytes(TOKEN_PROGRAM), addressToBytes(mint)]
  })
  return pda
}

/**
 * Seed for a wallet's i-th delayed-unstake stake account.
 *
 * @param {string} poolName - The pool's short name (lower-cased).
 * @param {number} index - The slot.
 * @returns {string} The seed.
 */
export function unstakeSeed (poolName, index) {
  return `${poolName.toLowerCase()}-unstake:${index}`
}

/**
 * Deterministic stake account for a wallet's i-th delayed unstake —
 * `createWithSeed(wallet, unstakeSeed(pool, i), StakeProgram)`. The wallet is
 * the only signer (no ephemeral keypair) and the position is recoverable from
 * the wallet alone, without getProgramAccounts.
 *
 * @param {string} wallet - The wallet.
 * @param {string} poolName - The pool's short name.
 * @param {number} index - The slot.
 * @returns {Promise<Address>} The stake account address.
 */
export async function findUnstakeAccount (wallet, poolName, index) {
  return await createAddressWithSeed({
    baseAddress: /** @type {Address} */ (wallet),
    programAddress: STAKE_PROGRAM,
    seed: unstakeSeed(poolName, index)
  })
}

/* ------------------------------------------------------------------------ */
/* Instruction encoders                                                     */
/* ------------------------------------------------------------------------ */

const acc = (address, role) => ({ address: /** @type {Address} */ (address), role })
const R = AccountRole.READONLY
const W = AccountRole.WRITABLE
const RS = AccountRole.READONLY_SIGNER
const WS = AccountRole.WRITABLE_SIGNER

/**
 * ComputeBudget `SetComputeUnitLimit` (2).
 *
 * @param {number} units - Compute units.
 * @returns {Instruction} The instruction.
 */
export function ixSetComputeUnitLimit (units) {
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: new Writer().u8(2).u32(units).build() }
}

/**
 * ComputeBudget `SetComputeUnitPrice` (3).
 *
 * @param {bigint} microLamports - Priority fee per compute unit.
 * @returns {Instruction} The instruction.
 */
export function ixSetComputeUnitPrice (microLamports) {
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: new Writer().u8(3).u64(microLamports).build() }
}

/**
 * Associated Token `CreateIdempotent` (1).
 *
 * @param {{ payer: string, ata: string, owner: string, mint: string }} p - Accounts.
 * @returns {Instruction} The instruction.
 */
export function ixCreateAtaIdempotent (p) {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [acc(p.payer, WS), acc(p.ata, W), acc(p.owner, R), acc(p.mint, R), acc(SYSTEM_PROGRAM, R), acc(TOKEN_PROGRAM, R)],
    data: Uint8Array.of(1)
  }
}

/**
 * @typedef {Object} PoolAccounts
 * @property {string} pool - The stake pool address.
 * @property {StakePoolState} state - Its decoded state.
 * @property {string} withdrawAuthority - The pool's withdraw authority PDA.
 */

/**
 * Stake Pool `DepositSol` (14), or `DepositSolWithSlippage` (25) when `minimumPoolTokensOut` is set.
 *
 * @param {PoolAccounts & { from: string, destination: string, lamports: bigint, minimumPoolTokensOut?: bigint }} p - Parameters.
 * @returns {Instruction} The instruction.
 */
export function ixDepositSol (p) {
  if (p.state.solDepositAuthority) throw new Error('spl-stake-pool: this pool restricts SOL deposits to its deposit authority.')
  const data = p.minimumPoolTokensOut === undefined
    ? new Writer().u8(14).u64(p.lamports).build()
    : new Writer().u8(25).u64(p.lamports).u64(p.minimumPoolTokensOut).build()
  return {
    programAddress: STAKE_POOL_PROGRAM,
    accounts: [
      acc(p.pool, W),
      acc(p.withdrawAuthority, R),
      acc(p.state.reserveStake, W),
      acc(p.from, WS),
      acc(p.destination, W),
      acc(p.state.managerFeeAccount, W),
      acc(p.destination, W), // referrer: the depositor — a referral share (0 on Jito) returns to them
      acc(p.state.poolMint, W),
      acc(SYSTEM_PROGRAM, R),
      acc(p.state.tokenProgram, R)
    ],
    data
  }
}

/**
 * Stake Pool `WithdrawSol` (16) / `WithdrawSolWithSlippage` (26): burn pool tokens, receive SOL from the reserve.
 *
 * @param {PoolAccounts & { owner: string, source: string, poolTokens: bigint, minimumLamportsOut?: bigint }} p - Parameters.
 * @returns {Instruction} The instruction.
 */
export function ixWithdrawSol (p) {
  if (p.state.solWithdrawAuthority) throw new Error('spl-stake-pool: this pool restricts SOL withdrawals to its withdraw authority.')
  const data = p.minimumLamportsOut === undefined
    ? new Writer().u8(16).u64(p.poolTokens).build()
    : new Writer().u8(26).u64(p.poolTokens).u64(p.minimumLamportsOut).build()
  return {
    programAddress: STAKE_POOL_PROGRAM,
    accounts: [
      acc(p.pool, W),
      acc(p.withdrawAuthority, R),
      acc(p.owner, RS),
      acc(p.source, W),
      acc(p.state.reserveStake, W),
      acc(p.owner, W),
      acc(p.state.managerFeeAccount, W),
      acc(p.state.poolMint, W),
      acc(SYSVAR_CLOCK, R),
      acc(SYSVAR_STAKE_HISTORY, R),
      acc(STAKE_PROGRAM, R),
      acc(p.state.tokenProgram, R)
    ],
    data
  }
}

/**
 * Stake Pool `WithdrawStake` (10) / `WithdrawStakeWithSlippage` (24): burn pool tokens, split a stake account to the wallet.
 *
 * @param {PoolAccounts & { owner: string, source: string, splitFrom: string, splitTo: string, poolTokens: bigint, minimumLamportsOut?: bigint }} p - Parameters.
 * @returns {Instruction} The instruction.
 */
export function ixWithdrawStake (p) {
  const data = p.minimumLamportsOut === undefined
    ? new Writer().u8(10).u64(p.poolTokens).build()
    : new Writer().u8(24).u64(p.poolTokens).u64(p.minimumLamportsOut).build()
  return {
    programAddress: STAKE_POOL_PROGRAM,
    accounts: [
      acc(p.pool, W),
      acc(p.state.validatorList, W),
      acc(p.withdrawAuthority, R),
      acc(p.splitFrom, W),
      acc(p.splitTo, W),
      acc(p.owner, R), // becomes stake + withdraw authority of the split account
      acc(p.owner, RS), // transfer authority over the pool-token account
      acc(p.source, W),
      acc(p.state.managerFeeAccount, W),
      acc(p.state.poolMint, W),
      acc(SYSVAR_CLOCK, R),
      acc(p.state.tokenProgram, R),
      acc(STAKE_PROGRAM, R)
    ],
    data
  }
}

/**
 * System `CreateAccountWithSeed` (3, bincode).
 *
 * @param {{ from: string, newAccount: string, base: string, seed: string, lamports: bigint, space: bigint, owner: string }} p - Parameters.
 * @returns {Instruction} The instruction.
 */
export function ixCreateAccountWithSeed (p) {
  const accounts = [acc(p.from, WS), acc(p.newAccount, W)]
  if (p.base !== p.from) accounts.push(acc(p.base, RS))
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts,
    data: new Writer().u32(3).address(p.base).bincodeString(p.seed).u64(p.lamports).u64(p.space).address(p.owner).build()
  }
}

/**
 * Stake `Deactivate` (5): [stake W, clock, stake authority S].
 *
 * @param {{ stake: string, authority: string }} p - Accounts.
 * @returns {Instruction} The instruction.
 */
export function ixStakeDeactivate (p) {
  return {
    programAddress: STAKE_PROGRAM,
    accounts: [acc(p.stake, W), acc(SYSVAR_CLOCK, R), acc(p.authority, RS)],
    data: new Writer().u32(5).build()
  }
}

/**
 * Stake `Withdraw` (4): [stake W, recipient W, clock, stake history, withdraw authority S].
 *
 * @param {{ stake: string, recipient: string, authority: string, lamports: bigint }} p - Parameters.
 * @returns {Instruction} The instruction.
 */
export function ixStakeWithdraw (p) {
  return {
    programAddress: STAKE_PROGRAM,
    accounts: [acc(p.stake, W), acc(p.recipient, W), acc(SYSVAR_CLOCK, R), acc(SYSVAR_STAKE_HISTORY, R), acc(p.authority, RS)],
    data: new Writer().u32(4).u64(p.lamports).build()
  }
}

/* ------------------------------------------------------------------------ */
/* Withdraw-source selection                                                */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {Object} WithdrawSource
 * @property {'validator' | 'reserve'} kind
 * @property {Address} account - The stake account to split from.
 * @property {Address | null} voteAccount
 * @property {bigint} lamports - What the list reports on it (reserve: the live balance the caller passed).
 */

/**
 * Picks the stake account `WithdrawStake` may split `lamports` from, the way
 * the program checks it: a preferred-withdraw validator that still holds the
 * tolerance must be used first; otherwise the best-funded active validator
 * that keeps `rent + minimum delegation` after the split; the reserve only
 * when no validator holds `rent + 2 × minimum delegation`.
 *
 * @param {{ pool: string, state: StakePoolState, validators: ValidatorStakeInfo[], lamports: bigint, rentExempt: bigint, minimumDelegation: bigint, reserveLamports: bigint }} p - Parameters.
 * @returns {Promise<WithdrawSource>} The source.
 */
export async function selectWithdrawSource (p) {
  const required = minimumStakeLamports(p.rentExempt, p.minimumDelegation)
  const tolerance = required + p.minimumDelegation
  const active = p.validators.filter((v) => v.status === 'active')
  const canServe = (v) => v.activeStakeLamports - p.lamports >= required

  const preferred = p.state.preferredWithdrawValidator
    ? active.find((v) => v.voteAccount === p.state.preferredWithdrawValidator)
    : undefined
  if (preferred && preferred.activeStakeLamports >= tolerance) {
    if (!canServe(preferred)) {
      throw new Error("spl-stake-pool: the pool's preferred withdraw validator can't cover this amount — withdraw less or split it across two withdrawals.")
    }
    return {
      kind: 'validator',
      account: await findValidatorStakeAccount(p.pool, preferred.voteAccount, preferred.validatorSeedSuffix),
      voteAccount: preferred.voteAccount,
      lamports: preferred.activeStakeLamports
    }
  }

  if (p.validators.some((v) => v.activeStakeLamports >= tolerance)) {
    const best = active.filter(canServe).sort((a, b) => (a.activeStakeLamports > b.activeStakeLamports ? -1 : 1))[0]
    if (!best) throw new Error('spl-stake-pool: no validator stake account can cover this amount in one withdrawal — try a smaller amount.')
    return {
      kind: 'validator',
      account: await findValidatorStakeAccount(p.pool, best.voteAccount, best.validatorSeedSuffix),
      voteAccount: best.voteAccount,
      lamports: best.activeStakeLamports
    }
  }

  if (p.reserveLamports - p.lamports < p.rentExempt) {
    throw new Error("spl-stake-pool: the pool reserve can't cover this amount.")
  }
  return { kind: 'reserve', account: p.state.reserveStake, voteAccount: null, lamports: p.reserveLamports }
}
