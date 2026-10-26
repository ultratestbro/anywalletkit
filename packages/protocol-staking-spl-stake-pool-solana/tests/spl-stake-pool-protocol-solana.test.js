'use strict'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import SplStakePoolProtocolSolana, { StakingProtocol, SPL_STAKE_POOL_ADDRESS_MAP, codec, parseDepositSol } from '../index.js'
import { JITO_POOL_ACCOUNT, JITO_VALIDATOR_LIST_HEAD, VALIDATOR_STAKE_ACCOUNT } from './fixtures.js'

const JITO = SPL_STAKE_POOL_ADDRESS_MAP.jito
const WITHDRAW_AUTHORITY = '6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS'
const HOLDER = '9hNaQ3crLjWihWa5BeQgSYfrPY3eoDmHJAX2sTWE8nUC'
const HOLDER_ATA = '2j7QrGvzM4bavXuGjCorApRdSgHELy3YEpnLpdFhRRPF'
const HOLDER_SLOT0 = 'GkjDuXZZhStb16o4f1BLyYzV6K1GqUhsQ497whWRMRNH'
const VALIDATOR0_STAKE = '5J574PrxGzUv6eEprDgTsDiwVZrNuVGTfqxN1YKoPX1Y'
const VOTE_A = 'hy1oJTV2kX9acsqpwk7hbteqXFw9VDbWvbxoamFEufW'
const VOTE_B = 'J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8DGUJ9Qv'
const SOL = 10n ** 9n
const RENT = 2_077_224n
const MIN_DELEGATION = SOL
const HASH = 'ab'.repeat(32)
const EPOCH = 1030n

const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
const toB64 = (u8) => Buffer.from(u8).toString('base64')
const POOL_STATE = codec.decodeStakePool(b64(JITO_POOL_ACCOUNT.data))
const le64 = (x) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(x), true); return b }
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }

/** A token account (165 bytes) holding `amount` for `owner`. */
function tokenAccount (owner, amount) {
  const d = new Uint8Array(165)
  d.set(codec.addressToBytes(JITO.mint), 0)
  d.set(codec.addressToBytes(owner), 32)
  d.set(le64(amount), 64)
  d[108] = 1 // initialized
  return d
}

/** A validator list with the given entries (all status active, seed suffix 0). */
function validatorList (entries) {
  const header = cat(Uint8Array.of(2), new Uint8Array(4), (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, entries.length, true); return b })())
  return cat(header, ...entries.map((e) => cat(le64(e.active), le64(e.transient ?? 0n), le64(EPOCH), le64(0n), new Uint8Array(4), new Uint8Array(4), Uint8Array.of(0), codec.addressToBytes(e.vote))))
}

/** A delegated stake account (200 bytes) owned by `authority`, deactivating at `deactivationEpoch` (u64::MAX = still delegated). */
function stakeAccount ({ authority, stake, activationEpoch = 900n, deactivationEpoch = 0xffffffffffffffffn }) {
  const d = new Uint8Array(200)
  const dv = new DataView(d.buffer)
  dv.setUint32(0, 2, true)
  d.set(le64(RENT), 4)
  d.set(codec.addressToBytes(authority), 12)
  d.set(codec.addressToBytes(authority), 44)
  d.set(codec.addressToBytes(VOTE_A), 124)
  d.set(le64(stake), 156)
  d.set(le64(activationEpoch), 164)
  d.set(le64(deactivationEpoch), 172)
  return d
}

/**
 * A JSON-RPC double serving the reads the module makes, keyed by address.
 * `accounts` maps address → { data: Uint8Array, lamports, owner }.
 */
function stubRpc ({ epoch = EPOCH, reserve = 1_045_392_561_161n, accounts = {}, balances = {} } = {}) {
  const calls = []
  const ACCOUNTS = {
    [JITO.pool]: { data: b64(JITO_POOL_ACCOUNT.data), lamports: JITO_POOL_ACCOUNT.lamports, owner: codec.STAKE_POOL_PROGRAM },
    ...accounts
  }
  const info = (address) => {
    const a = ACCOUNTS[address]
    return a ? { data: [toB64(a.data), 'base64'], lamports: Number(a.lamports ?? 0n), owner: a.owner ?? codec.STAKE_PROGRAM } : null
  }
  return {
    calls,
    async request (method, params) {
      calls.push(method)
      switch (method) {
        case 'getEpochInfo': return { epoch: Number(epoch), slotIndex: 100_000, slotsInEpoch: 432_000 }
        case 'getMinimumBalanceForRentExemption': return Number(RENT)
        case 'getStakeMinimumDelegation': return { value: Number(MIN_DELEGATION) }
        case 'getAccountInfo': return { value: info(params[0]) }
        case 'getMultipleAccounts': return { value: params[0].map(info) }
        case 'getBalance': {
          if (params[0] === POOL_STATE.reserveStake) return { value: Number(reserve) }
          if (params[0] in balances) return { value: Number(balances[params[0]]) }
          return { value: Number(ACCOUNTS[params[0]]?.lamports ?? 0n) }
        }
        default: throw new Error(`stub rpc: unexpected ${method}`)
      }
    }
  }
}

function stubAccount (address = HOLDER, { readOnly = false } = {}) {
  const sent = []
  const account = { sent, async getAddress () { return address } }
  if (!readOnly) {
    account.sendTransaction = async (message) => { sent.push(message); return { hash: HASH, fee: 5_000n } }
    account.quoteSendTransaction = async () => ({ fee: 5_000n })
  }
  return account
}

const protocolFor = (rpc, account = stubAccount()) => new SplStakePoolProtocolSolana(account, { provider: rpc })
/** The stake account PDA the synthetic validator list's VOTE_A entry maps to. */
const VOTE_A_STAKE = await codec.findValidatorStakeAccount(JITO.pool, VOTE_A, 0)

// ---- base + construction ----

test('the base class throws NotImplementedError on every method', async () => {
  const base = new StakingProtocol({})
  for (const method of ['stake', 'quoteStake', 'requestWithdrawal', 'quoteRequestWithdrawal', 'getWithdrawalRequests', 'claimWithdrawals', 'quoteClaimWithdrawals', 'getStakedBalance', 'getApr']) {
    await assert.rejects(() => base[method]({ amount: 1n }), (err) => err.name === 'NotImplementedError')
  }
})

test('constructor: Jito by default, explicit pools accepted, unknown keys refused, reads need a provider', async () => {
  assert.equal(new SplStakePoolProtocolSolana({}, { provider: 'http://x' }).pool.mint, JITO.mint)
  const custom = new SplStakePoolProtocolSolana({}, { provider: 'http://x', pool: { name: 'Other', pool: JITO.pool, mint: JITO.mint, symbol: 'oSOL' } })
  assert.equal(custom.pool.symbol, 'oSOL')
  assert.throws(() => new SplStakePoolProtocolSolana({}, { pool: 'marinade' }), /Unknown stake pool/)
  await assert.rejects(() => new SplStakePoolProtocolSolana({ async getAddress () { return HOLDER } }).getPoolData(), /provider/)
})

// ---- decoders on mainnet bytes ----

test('decodeStakePool reads the Jito state: mint, epoch, fees, open authorities, rate', () => {
  const s = POOL_STATE
  assert.equal(s.poolMint, JITO.mint)
  assert.equal(s.lastUpdateEpoch, 1030n)
  assert.equal(s.validatorList, '3R3nGZpQs2aZo5FDQvd2MUQ6R7KhAPainds6uT6uE2mn')
  assert.equal(s.reserveStake, 'BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL')
  assert.equal(s.managerFeeAccount, '8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa')
  assert.deepEqual(s.solWithdrawalFee, { denominator: 1000n, numerator: 1n })
  assert.deepEqual(s.stakeWithdrawalFee, { denominator: 1000n, numerator: 1n })
  assert.deepEqual(s.solDepositFee, { denominator: 0n, numerator: 0n })
  assert.deepEqual(s.epochFee, { denominator: 100n, numerator: 4n })
  assert.equal(s.solDepositAuthority, null)
  assert.equal(s.solWithdrawAuthority, null)
  assert.equal(s.preferredWithdrawValidator, null)
  assert.equal(codec.poolRate(s), 1_300_046_043n)
  assert.equal(codec.feePercent(s.solWithdrawalFee), 0.1)
})

test('decodeValidatorList reads the header and whole entries of a prefix; decodeStakeAccount matches the first validator', () => {
  const list = codec.decodeValidatorList(b64(JITO_VALIDATOR_LIST_HEAD))
  assert.equal(list.maxValidators, 10_000)
  assert.equal(list.validators.length, 2) // 681 on chain; the fixture carries two whole entries
  const v0 = list.validators[0]
  assert.equal(v0.activeStakeLamports, VALIDATOR_STAKE_ACCOUNT.lamports)
  assert.equal(v0.status, 'active')
  const stake = codec.decodeStakeAccount(b64(VALIDATOR_STAKE_ACCOUNT.data))
  assert.equal(stake.state, 'stake')
  assert.equal(stake.withdrawer, WITHDRAW_AUTHORITY)
  assert.equal(stake.delegation.voter, v0.voteAccount)
  assert.equal(codec.stakeActivation(stake, EPOCH), 'active')
})

test('stakeActivation follows the delegation epochs', () => {
  const still = codec.decodeStakeAccount(stakeAccount({ authority: HOLDER, stake: SOL }))
  assert.equal(codec.stakeActivation(still, EPOCH), 'active')
  assert.equal(codec.stakeActivation(codec.decodeStakeAccount(stakeAccount({ authority: HOLDER, stake: SOL, activationEpoch: EPOCH })), EPOCH), 'activating')
  const deact = codec.decodeStakeAccount(stakeAccount({ authority: HOLDER, stake: SOL, deactivationEpoch: EPOCH }))
  assert.equal(codec.stakeActivation(deact, EPOCH), 'deactivating')
  assert.equal(codec.stakeActivation(deact, EPOCH + 1n), 'inactive')
})

// ---- addresses ----

test('PDAs and seed addresses match mainnet', async () => {
  assert.equal(await codec.findWithdrawAuthority(JITO.pool), WITHDRAW_AUTHORITY)
  assert.equal(await codec.findAta(HOLDER, JITO.mint), HOLDER_ATA)
  assert.equal(await codec.findUnstakeAccount(HOLDER, 'Jito', 0), HOLDER_SLOT0)
  const v0 = codec.decodeValidatorList(b64(JITO_VALIDATOR_LIST_HEAD)).validators[0]
  assert.equal(await codec.findValidatorStakeAccount(JITO.pool, v0.voteAccount, v0.validatorSeedSuffix), VALIDATOR0_STAKE)
  assert.equal(codec.unstakeSeed('Jito', 3), 'jito-unstake:3')
})

// ---- arithmetic (figures cross-checked with simulateTransaction on 2026-09-07) ----

test('quotes reproduce the program arithmetic', () => {
  assert.deepEqual(codec.quoteDepositSol(POOL_STATE, SOL / 10n), { poolTokens: 76_920_352n, feeTokens: 0n })
  assert.deepEqual(codec.quoteWithdrawSol(POOL_STATE, SOL / 20n), { lamports: 64_937_299n, feeTokens: 50_000n, burnt: 49_950_000n })
  assert.equal(codec.quoteWithdrawStake(POOL_STATE, SOL).lamports, 1_298_745_997n)
  assert.equal(codec.minimumStakeLamports(RENT, MIN_DELEGATION), 1_002_077_224n)
  assert.equal(codec.applyFee({ denominator: 0n, numerator: 5n }, 100n), 0n)
})

// ---- instruction bytes ----

test('instruction encoders lay out data and accounts as the programs expect', () => {
  const dep = codec.ixDepositSol({ pool: JITO.pool, state: POOL_STATE, withdrawAuthority: WITHDRAW_AUTHORITY, from: HOLDER, destination: HOLDER_ATA, lamports: 100n, minimumPoolTokensOut: 7n })
  assert.deepEqual([...dep.data], [25, 100, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(dep.accounts.length, 10)
  assert.deepEqual(dep.accounts[3], { address: HOLDER, role: 3 }) // funder: writable signer
  assert.equal(dep.accounts[2].address, POOL_STATE.reserveStake)
  assert.equal(codec.ixDepositSol({ pool: JITO.pool, state: POOL_STATE, withdrawAuthority: WITHDRAW_AUTHORITY, from: HOLDER, destination: HOLDER_ATA, lamports: 1n }).data[0], 14)

  const ws = codec.ixWithdrawSol({ pool: JITO.pool, state: POOL_STATE, withdrawAuthority: WITHDRAW_AUTHORITY, owner: HOLDER, source: HOLDER_ATA, poolTokens: 5n })
  assert.equal(ws.data[0], 16)
  assert.equal(ws.accounts.length, 12)
  assert.deepEqual(ws.accounts[2], { address: HOLDER, role: 2 }) // transfer authority: readonly signer

  const wst = codec.ixWithdrawStake({ pool: JITO.pool, state: POOL_STATE, withdrawAuthority: WITHDRAW_AUTHORITY, owner: HOLDER, source: HOLDER_ATA, splitFrom: VALIDATOR0_STAKE, splitTo: HOLDER_SLOT0, poolTokens: 5n, minimumLamportsOut: 1n })
  assert.equal(wst.data[0], 24)
  assert.equal(wst.accounts.length, 13)
  assert.equal(wst.accounts[1].address, POOL_STATE.validatorList)
  assert.equal(wst.accounts[12].address, codec.STAKE_PROGRAM)

  const create = codec.ixCreateAccountWithSeed({ from: HOLDER, newAccount: HOLDER_SLOT0, base: HOLDER, seed: 'jito-unstake:0', lamports: RENT, space: 200n, owner: codec.STAKE_PROGRAM })
  assert.deepEqual([...create.data.slice(0, 4)], [3, 0, 0, 0])
  assert.deepEqual([...create.data.slice(36, 44)], [14, 0, 0, 0, 0, 0, 0, 0]) // seed length
  assert.equal(create.data.length, 4 + 32 + 8 + 14 + 8 + 8 + 32)
  assert.equal(create.accounts.length, 2) // base == from: no third account

  assert.deepEqual([...codec.ixStakeDeactivate({ stake: HOLDER_SLOT0, authority: HOLDER }).data], [5, 0, 0, 0])
  const wd = codec.ixStakeWithdraw({ stake: HOLDER_SLOT0, recipient: HOLDER, authority: HOLDER, lamports: 258n })
  assert.deepEqual([...wd.data], [4, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0])
  assert.equal(wd.accounts[3].address, codec.SYSVAR_STAKE_HISTORY)
  assert.deepEqual([...codec.ixSetComputeUnitPrice(50_000n).data], [3, 80, 195, 0, 0, 0, 0, 0, 0])
  assert.throws(() => codec.ixDepositSol({ pool: JITO.pool, state: { ...POOL_STATE, solDepositAuthority: HOLDER }, withdrawAuthority: WITHDRAW_AUTHORITY, from: HOLDER, destination: HOLDER_ATA, lamports: 1n }), /deposit authority/)
})

// ---- pool view ----

test('getPoolData decodes, checks the mint, and reports liquidity, rates and fees', async () => {
  const p = protocolFor(stubRpc())
  const pool = await p.getPoolData()
  assert.equal(pool.updated, true)
  assert.equal(pool.withdrawAuthority, WITHDRAW_AUTHORITY)
  assert.equal(pool.rate, 1_300_046_043n)
  assert.ok(pool.previousRate < pool.rate)
  assert.equal(pool.instantLiquidity, 1_045_392_561_161n - RENT)
  assert.equal(pool.minimumStakeLamports, 1_002_077_224n)
  assert.deepEqual(pool.fees, { solDepositPct: 0, solWithdrawalPct: 0.1, stakeWithdrawalPct: 0.1, epochPct: 4 })
  const wrongMint = new SplStakePoolProtocolSolana(stubAccount(), { provider: stubRpc(), pool: { name: 'X', pool: JITO.pool, mint: HOLDER, symbol: 'X' } })
  await assert.rejects(() => wrongMint.getPoolData(), /does not match/)
})

test('getApr estimates from the last two epochs, or defers to the hook', async () => {
  const apr = await protocolFor(stubRpc()).getApr()
  assert.ok(apr > 2 && apr < 6, `on-chain estimate ${apr}`)
  const hooked = new SplStakePoolProtocolSolana(stubAccount(), { provider: stubRpc(), apr: async () => 4.9 })
  assert.equal(await hooked.getApr(), 4.9)
})

// ---- stake ----

test('stake sends budget + ATA create + DepositSolWithSlippage, quoted at the pool rate', async () => {
  const account = stubAccount()
  const p = protocolFor(stubRpc(), account)
  const result = await p.stake({ amount: SOL / 10n })
  assert.equal(result.hash, HASH)
  assert.equal(result.fee, 5_000n)
  const msg = account.sent[0]
  assert.equal(msg.version, 0)
  assert.equal(msg.instructions.length, 4)
  assert.equal(msg.instructions[0].programAddress, codec.COMPUTE_BUDGET_PROGRAM)
  assert.equal(msg.instructions[2].programAddress, codec.ATA_PROGRAM)
  const dep = msg.instructions[3]
  assert.equal(dep.data[0], 25)
  assert.equal(new DataView(dep.data.buffer).getBigUint64(9, true), (76_920_352n * 9_950n) / 10_000n)
  assert.equal(dep.accounts[4].address, HOLDER_ATA)
  const quote = await p.quoteStake({ amount: SOL / 10n })
  assert.deepEqual(quote, { fee: 5_000n, amountOut: 76_920_352n })
})

test('stake guards: amount shape, stale pool, read-only account', async () => {
  await assert.rejects(() => protocolFor(stubRpc()).stake({ amount: 0n }), /greater than zero/)
  await assert.rejects(() => protocolFor(stubRpc()).stake({ amount: 1.5 }), /safe integer/)
  await assert.rejects(() => protocolFor(stubRpc({ epoch: 1031n })).stake({ amount: SOL }), /not yet updated for epoch 1031/)
  await assert.rejects(() => protocolFor(stubRpc(), stubAccount(HOLDER, { readOnly: true })).stake({ amount: SOL }), /non read-only/)
})

// ---- unstake ----

const withPosition = ({ accounts, balances, ...rest } = {}) => stubRpc({
  accounts: {
    [HOLDER_ATA]: { data: tokenAccount(HOLDER, 5n * SOL), lamports: 2_039_280n, owner: codec.TOKEN_PROGRAM },
    [POOL_STATE.validatorList]: { data: validatorList([{ vote: VOTE_A, active: 197_304n * SOL }, { vote: VOTE_B, active: 3_091_411n }]), lamports: 1n, owner: codec.STAKE_POOL_PROGRAM },
    ...accounts
  },
  balances: { [VOTE_A_STAKE]: 197_304n * SOL, ...balances },
  ...rest
})

test('instant exit burns against the reserve with a slippage floor; refuses beyond the reserve', async () => {
  const account = stubAccount()
  const p = protocolFor(withPosition(), account)
  const r = await p.requestWithdrawal({ amount: SOL / 20n, mode: 'instant' })
  assert.equal(r.amountOut, 64_937_299n)
  assert.equal(r.stakeAccount, null)
  const ix = account.sent[0].instructions[2]
  assert.equal(ix.data[0], 26)
  assert.equal(new DataView(ix.data.buffer).getBigUint64(9, true), (64_937_299n * 9_950n) / 10_000n)
  await assert.rejects(() => protocolFor(withPosition({ reserve: SOL })).requestWithdrawal({ amount: 4n * SOL, mode: 'instant' }), /reserve can pay/)
  await assert.rejects(() => p.requestWithdrawal({ amount: 6n * SOL, mode: 'instant' }), /exceeds the JitoSOL balance/)
  await assert.rejects(() => p.requestWithdrawal({ amount: SOL, mode: 'later' }), /'mode'/)
})

test('delayed exit: seed account + WithdrawStakeWithSlippage from the best-funded validator + Deactivate', async () => {
  const account = stubAccount()
  const p = protocolFor(withPosition(), account)
  const r = await p.requestWithdrawal({ amount: SOL })
  assert.equal(r.amountOut, 1_298_745_997n)
  assert.equal(r.stakeAccount, HOLDER_SLOT0)
  const [, , create, withdraw, deactivate] = account.sent[0].instructions
  assert.equal(create.programAddress, codec.SYSTEM_PROGRAM)
  assert.equal(create.accounts[1].address, HOLDER_SLOT0)
  assert.equal(withdraw.data[0], 24)
  assert.equal(withdraw.accounts[3].address, VOTE_A_STAKE) // VOTE_A's stake account, not the 0.003 SOL one
  assert.equal(withdraw.accounts[4].address, HOLDER_SLOT0)
  assert.deepEqual([...deactivate.data], [5, 0, 0, 0])
  assert.equal(deactivate.accounts[0].address, HOLDER_SLOT0)
  const quote = await p.quoteRequestWithdrawal({ amount: SOL, mode: 'delayed' })
  assert.deepEqual(quote, { fee: 5_000n, amountOut: 1_298_745_997n, feeTokens: 1_000_000n })
})

test('delayed exit guards: below the stake minimum, all slots in use, validator moved', async () => {
  await assert.rejects(() => protocolFor(withPosition()).requestWithdrawal({ amount: SOL / 10n }), /at least 1002077224 lamports/)
  const full = {}
  for (let i = 0; i < 8; i++) full[await codec.findUnstakeAccount(HOLDER, 'Jito', i)] = { data: stakeAccount({ authority: HOLDER, stake: SOL, deactivationEpoch: EPOCH }), lamports: SOL + RENT }
  await assert.rejects(() => protocolFor(withPosition({ accounts: full })).requestWithdrawal({ amount: SOL }), /slots are in use/)
  await assert.rejects(() => protocolFor(withPosition({ balances: { [VOTE_A_STAKE]: 2n * SOL } })).requestWithdrawal({ amount: SOL }), /moved since/)
})

test('selectWithdrawSource: preferred validator first, reserve only when validators hold nothing', async () => {
  const base = { pool: JITO.pool, rentExempt: RENT, minimumDelegation: MIN_DELEGATION, reserveLamports: 100n * SOL, lamports: 2n * SOL }
  const validators = [{ voteAccount: VOTE_A, activeStakeLamports: 10n * SOL, transientStakeLamports: 0n, lastUpdateEpoch: EPOCH, transientSeedSuffix: 0n, validatorSeedSuffix: 0, status: 'active' }, { voteAccount: VOTE_B, activeStakeLamports: 50n * SOL, transientStakeLamports: 0n, lastUpdateEpoch: EPOCH, transientSeedSuffix: 0n, validatorSeedSuffix: 0, status: 'active' }]
  const best = await codec.selectWithdrawSource({ ...base, state: POOL_STATE, validators })
  assert.equal(best.voteAccount, VOTE_B)
  const preferred = await codec.selectWithdrawSource({ ...base, state: { ...POOL_STATE, preferredWithdrawValidator: VOTE_A }, validators })
  assert.equal(preferred.voteAccount, VOTE_A)
  await assert.rejects(() => codec.selectWithdrawSource({ ...base, lamports: 9n * SOL, state: { ...POOL_STATE, preferredWithdrawValidator: VOTE_A }, validators }), /preferred withdraw validator/)
  const reserve = await codec.selectWithdrawSource({ ...base, state: POOL_STATE, validators: validators.map((v) => ({ ...v, activeStakeLamports: RENT })) })
  assert.equal(reserve.kind, 'reserve')
  await assert.rejects(() => codec.selectWithdrawSource({ ...base, reserveLamports: SOL, state: POOL_STATE, validators: [] }), /reserve/)
})

// ---- queue + claim ----

test('getWithdrawalRequests lists seed slots; claimable once inactive; claimWithdrawals sweeps them', async () => {
  const slot0 = await codec.findUnstakeAccount(HOLDER, 'Jito', 0)
  const slot1 = await codec.findUnstakeAccount(HOLDER, 'Jito', 1)
  const accounts = {
    [slot0]: { data: stakeAccount({ authority: HOLDER, stake: SOL, deactivationEpoch: EPOCH - 1n }), lamports: SOL + RENT + 123n },
    [slot1]: { data: stakeAccount({ authority: HOLDER, stake: 2n * SOL, deactivationEpoch: EPOCH }), lamports: 2n * SOL + RENT }
  }
  const account = stubAccount()
  const p = protocolFor(stubRpc({ accounts }), account)
  const view = await p.getWithdrawalRequests()
  assert.equal(view.requests.length, 2)
  assert.deepEqual(view.claimableIds, [0n])
  assert.equal(view.claimableAmount, SOL + RENT + 123n)
  assert.equal(view.pendingAmount, 2n * SOL + RENT)
  assert.equal(view.requests.find((r) => r.id === 1n).status, 'deactivating')
  const claim = await p.claimWithdrawals()
  assert.equal(claim.amount, SOL + RENT + 123n)
  const ix = account.sent[0].instructions[2]
  assert.deepEqual([...ix.data], [4, 0, 0, 0, ...le64(SOL + RENT + 123n)])
  assert.equal(ix.accounts[0].address, slot0)
  assert.equal(ix.accounts[1].address, HOLDER)
  await assert.rejects(() => p.claimWithdrawals({ ids: [1n] }), /not claimable/)
  await assert.rejects(() => protocolFor(stubRpc()).claimWithdrawals(), /Nothing is claimable/)
})

test('getStakedBalance values the tokens at the pool rate', async () => {
  const position = await protocolFor(withPosition()).getStakedBalance()
  assert.equal(position.balance, 5n * SOL)
  assert.equal(position.rate, 1_300_046_043n)
  assert.equal(position.total, 6_500_230_215n)
  assert.equal(position.wrappedBalance, 0n)
})

// ---- rewards parsing ----

test('parseDepositSol reads a jsonParsed DepositSol, top-level or CPI, and the token delta', () => {
  const encode58 = (bytes) => {
    const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    let n = 0n
    for (const b of bytes) n = n * 256n + BigInt(b)
    let s = ''
    while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n }
    for (const b of bytes) { if (b !== 0) break; s = '1' + s }
    return s
  }
  const ix = { programId: codec.STAKE_POOL_PROGRAM, accounts: [JITO.pool, WITHDRAW_AUTHORITY, POOL_STATE.reserveStake, HOLDER, HOLDER_ATA], data: encode58(cat(Uint8Array.of(14), le64(SOL))) }
  const tx = (top, inner) => ({
    blockTime: 1_757_000_000,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: '100' } }],
      postTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: '769203620' } }],
      innerInstructions: inner ? [{ index: 0, instructions: [ix] }] : []
    },
    transaction: { message: { accountKeys: [{ pubkey: HOLDER }, { pubkey: HOLDER_ATA }], instructions: top ? [ix] : [{ programId: 'Router', accounts: [], data: '' }] } }
  })
  assert.deepEqual(parseDepositSol(tx(true, false), HOLDER, HOLDER_ATA), { lamports: SOL, minted: 769_203_520n })
  assert.deepEqual(parseDepositSol(tx(false, true), HOLDER, HOLDER_ATA), { lamports: SOL, minted: 769_203_520n })
  assert.equal(parseDepositSol(tx(false, false), HOLDER, HOLDER_ATA), null)
  assert.equal(parseDepositSol(tx(true, false), VOTE_A, HOLDER_ATA), null)
})

test('getRewards averages entry rates from the account history', async () => {
  const rpc = withPosition()
  const inner = rpc.request
  rpc.request = async (method, params) => {
    if (method === 'getSignaturesForAddress') return [{ signature: 's1', err: null }, { signature: 's2', err: { x: 1 } }]
    if (method === 'getTransaction') {
      const encode58 = (bytes) => { const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n } return s }
      return {
        blockTime: 1_757_000_000,
        meta: { err: null, preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: String(5n * SOL) } }] },
        transaction: { message: { accountKeys: [{ pubkey: HOLDER }, { pubkey: HOLDER_ATA }], instructions: [{ programId: codec.STAKE_POOL_PROGRAM, accounts: [JITO.pool, WITHDRAW_AUTHORITY, POOL_STATE.reserveStake, HOLDER, HOLDER_ATA], data: encode58(cat(Uint8Array.of(14), le64(6n * SOL))) }] } }
      }
    }
    return inner(method, params)
  }
  const rewards = await protocolFor(rpc).getRewards()
  assert.equal(rewards.entryRate, 1_200_000_000n) // 6 SOL bought 5 JitoSOL
  assert.equal(rewards.earned, (5n * SOL * (1_300_046_043n - 1_200_000_000n)) / SOL)
  assert.equal(rewards.firstStakeAt, 1_757_000_000)
})

// ---- transport ----

test('_rpc fails over on transport errors but not on node-side rejections', async () => {
  const p = new SplStakePoolProtocolSolana(stubAccount(), {
    provider: [
      { async request () { throw new Error('ECONNRESET') } },
      { async request (method) { if (method === 'getEpochInfo') return { epoch: 1030, slotIndex: 1, slotsInEpoch: 432_000 }; throw Object.assign(new Error('boom'), { final: true }) } }
    ]
  })
  assert.equal((await p.getEpochInfo()).epoch, 1030n)
  await assert.rejects(() => p._rpc('getBalance', [HOLDER]), /boom/)
})

// Audit 2026-10-25 round 3, M30: the delayed-exit slot addresses are predictable (wallet + seed).
// Anyone could send a little SOL to all eight of them: CreateAccountWithSeed then fails on each, and
// the module said "all slots are in use" — delayed exits blocked for ~0.007 SOL. Pre-funded
// addresses (System-owned) are now skipped without counting against the tracked slots, the scan
// goes on past them (bounded), and only beyond the bound does it refuse, naming the cause.
test('delayed exit: pre-funded slot addresses are skipped, the exit lands past them and is listed', async () => {
  const prefunded = { data: new Uint8Array(0), lamports: 890_880n, owner: codec.SYSTEM_PROGRAM }
  const poisoned = {}
  for (let i = 0; i < 8; i++) poisoned[await codec.findUnstakeAccount(HOLDER, 'Jito', i)] = prefunded
  const account = stubAccount()
  const r = await protocolFor(withPosition({ accounts: poisoned }), account).requestWithdrawal({ amount: SOL })
  const slot8 = await codec.findUnstakeAccount(HOLDER, 'Jito', 8)
  assert.equal(r.stakeAccount, slot8)
  assert.equal(account.sent[0].instructions[2].accounts[1].address, slot8)

  const withExit = { ...poisoned, [slot8]: { data: stakeAccount({ authority: HOLDER, stake: SOL, deactivationEpoch: EPOCH - 1n }), lamports: SOL + RENT } }
  const { requests } = await protocolFor(withPosition({ accounts: withExit })).getWithdrawalRequests()
  assert.deepEqual(requests.map((q) => q.id), [8n])
})

test('delayed exit: refused with the cause named only when pre-funded addresses exhaust the bound', async () => {
  const prefunded = { data: new Uint8Array(0), lamports: 890_880n, owner: codec.SYSTEM_PROGRAM }
  const many = {}
  for (let i = 0; i < 8 + 32; i++) many[await codec.findUnstakeAccount(HOLDER, 'Jito', i)] = prefunded
  await assert.rejects(() => protocolFor(withPosition({ accounts: many })).requestWithdrawal({ amount: SOL }), /40 slot addresses hold SOL someone else sent there.*instant/)
})
