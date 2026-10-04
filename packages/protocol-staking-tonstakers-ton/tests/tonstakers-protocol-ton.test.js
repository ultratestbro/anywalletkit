'use strict'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Address, Cell, TupleReader, beginCell } from '@ton/core'
import { TonClient } from '@ton/ton'

import TonstakersProtocolTon, {
  StakingProtocol, TONSTAKERS_ADDRESS_MAP, OP_STAKE, OP_UNSTAKE, STAKE_FEE_RESERVE, UNSTAKE_FEE_RESERVE, buildUnstakeBody
} from '../index.js'

const { pool: POOL, jetton: MINTER, partnerCode: PARTNER } = TONSTAKERS_ADDRESS_MAP['-239']
const OWNER = 'UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq'
const JETTON_WALLET = 'EQB15F1CTmKEBo6qAiljTPnYtSU3131xyY31MPFBVA_dsl3o'
const NANO = 10n ** 9n
const HASH = 'ab'.repeat(32)

const int = (v) => ({ type: 'int', value: BigInt(v) })
const addrCell = (a) => ({ type: 'cell', cell: beginCell().storeAddress(Address.parse(a)).endCell() })
const nul = { type: 'null' }
const tuple = { type: 'tuple', items: [] }

/** get_pool_full_data as the mainnet pool lays it out (30 items). */
function poolStack ({ halted = false, depositsOpen = true, balance = 128685896370406591n, supply = 111654561526390897n, projBalance = 128716607858568389n, projSupply = 111654561526390897n } = {}) {
  return [
    int(0), int(halted ? -1 : 0), int(balance), int(9575), int(-1), int(depositsOpen ? -1 : 0),
    int(123), tuple, tuple, int(1), int(2), int(3),
    addrCell(MINTER), int(supply), nul, int(0), addrCell('EQB4UnpaXqYPlnjo3F8_1v1Xyr15TxCL__S0xlXlA3E1AHn9'), int(0),
    addrCell(POOL), int(0), addrCell(POOL), int(0), addrCell(POOL), addrCell(POOL), addrCell(POOL),
    { type: 'cell', cell: new Cell() }, { type: 'cell', cell: new Cell() }, { type: 'cell', cell: new Cell() },
    int(projBalance), int(projSupply)
  ]
}

/** A TonClient double answering the get-methods this module runs. */
function stubClient ({ pool = {}, tsTon = 5n * NANO, walletDeployed = true, liquidity = 200_000n * NANO, flakyOnce = false } = {}) {
  const client = Object.create(TonClient.prototype)
  let flaked = false
  client.calls = []
  client.runMethodWithError = async (address, name, args) => {
    client.calls.push({ address: address.toString(), name })
    if (name === 'get_pool_full_data') {
      if (flakyOnce && !flaked) {
        flaked = true
        return { exit_code: -13, gas_used: 0, stack: new TupleReader([]) }
      }
      return { exit_code: 0, gas_used: 9244, stack: new TupleReader(poolStack(pool)) }
    }
    if (name === 'get_wallet_address') {
      assert.equal(address.toString(), MINTER)
      assert.equal(args[0].cell.beginParse().loadAddress().toString({ bounceable: false }), OWNER)
      return { exit_code: 0, gas_used: 1, stack: new TupleReader([addrCell(JETTON_WALLET)]) }
    }
    if (name === 'get_wallet_data') {
      assert.equal(address.toString(), JETTON_WALLET)
      if (!walletDeployed) return { exit_code: -13, gas_used: 0, stack: new TupleReader([]) }
      return { exit_code: 0, gas_used: 1, stack: new TupleReader([int(tsTon), addrCell(OWNER), addrCell(MINTER), { type: 'cell', cell: new Cell() }]) }
    }
    throw new Error(`stub client: unexpected get-method ${name}`)
  }
  client.getBalance = async () => liquidity
  return client
}

function stubAccount (client) {
  const sent = []
  return {
    sent,
    async getAddress () { return OWNER },
    async sendTransaction (tx) {
      sent.push(tx)
      return { hash: HASH, fee: 7n }
    },
    async quoteSendTransaction () { return { fee: 3n } },
    _tonClient: client
  }
}

test('the base class throws NotImplementedError on every method', async () => {
  const base = new StakingProtocol({})
  for (const method of ['stake', 'quoteStake', 'requestWithdrawal', 'quoteRequestWithdrawal', 'getWithdrawalRequests', 'claimWithdrawals', 'quoteClaimWithdrawals', 'getStakedBalance', 'getApr']) {
    await assert.rejects(() => base[method]({ amount: 1n }), (err) => err.name === 'NotImplementedError')
  }
})

test('constructor refuses unknown networks without a pool address and needs a client for reads', async () => {
  assert.throws(() => new TonstakersProtocolTon({}, { network: '-5' }), /addresses/)
  const noClient = new TonstakersProtocolTon({ async getAddress () { return OWNER } })
  await assert.rejects(() => noClient.getPoolData(), /tonClient/)
})

test('getPoolData parses the 30-item stack and survives a -13 on the first try', async () => {
  const protocol = new TonstakersProtocolTon(stubAccount(stubClient({ flakyOnce: true })))
  const pool = await protocol.getPoolData()
  assert.equal(pool.halted, false)
  assert.equal(pool.depositsOpen, true)
  assert.equal(pool.jettonMinter.toString(), MINTER)
  assert.equal(pool.withdrawalPayout.toString(), 'EQB4UnpaXqYPlnjo3F8_1v1Xyr15TxCL__S0xlXlA3E1AHn9')
  assert.equal(pool.rate, (128685896370406591n * NANO) / 111654561526390897n)
  assert.ok(pool.projectedRate > pool.rate)
})

test('stake sends one message to the pool: amount + 1 GRAM reserve, the SDK payload', async () => {
  const account = stubAccount(stubClient())
  const protocol = new TonstakersProtocolTon(account)
  const result = await protocol.stake({ amount: 2n * NANO })
  assert.equal(result.hash, HASH)
  assert.equal(account.sent.length, 1)
  const tx = account.sent[0]
  assert.equal(tx.to, Address.parse(POOL).toString({ bounceable: true }))
  assert.equal(tx.value, 2n * NANO + STAKE_FEE_RESERVE)
  assert.equal(tx.bounceable, true)
  const s = tx.body.beginParse()
  assert.equal(s.loadUint(32), OP_STAKE)
  assert.equal(s.loadUint(64), 1)
  assert.equal(s.loadUintBig(64), PARTNER)
})

test('stake guards: minimum, halted pool, closed deposits, read-only account', async () => {
  await assert.rejects(() => new TonstakersProtocolTon(stubAccount(stubClient())).stake({ amount: NANO - 1n }), /at least 1 GRAM/)
  await assert.rejects(() => new TonstakersProtocolTon(stubAccount(stubClient({ pool: { halted: true } }))).stake({ amount: NANO }), /halted/)
  await assert.rejects(() => new TonstakersProtocolTon(stubAccount(stubClient({ pool: { depositsOpen: false } }))).stake({ amount: NANO }), /closed/)
  const readOnly = new TonstakersProtocolTon({ async getAddress () { return OWNER }, _tonClient: stubClient() })
  await assert.rejects(() => readOnly.stake({ amount: NANO }), /non read-only/)
})

test('requestWithdrawal burns on the jetton wallet with the mode bits, 1.05 GRAM attached', async () => {
  for (const [mode, wait, fok] of [['standard', 0, 0], ['instant', 0, 1], ['bestRate', 1, 0]]) {
    const account = stubAccount(stubClient())
    const protocol = new TonstakersProtocolTon(account)
    const result = await protocol.requestWithdrawal({ amount: NANO, mode })
    assert.equal(result.approveHash, null)
    const tx = account.sent[0]
    assert.equal(tx.to, JETTON_WALLET)
    assert.equal(tx.value, UNSTAKE_FEE_RESERVE)
    const s = tx.body.beginParse()
    assert.equal(s.loadUint(32), OP_UNSTAKE)
    assert.equal(s.loadUint(64), 0)
    assert.equal(s.loadCoins(), NANO)
    assert.equal(s.loadAddress().toString({ bounceable: false }), OWNER)
    const bits = s.loadMaybeRef().beginParse()
    assert.equal(bits.loadUint(1), wait, mode)
    assert.equal(bits.loadUint(1), fok, mode)
  }
  assert.throws(() => buildUnstakeBody(1n, Address.parse(OWNER), 'later'), /mode/)
})

test('instant exits refuse when the pool cannot cover them', async () => {
  const protocol = new TonstakersProtocolTon(stubAccount(stubClient({ liquidity: NANO })))
  await assert.rejects(() => protocol.requestWithdrawal({ amount: 5n * NANO, mode: 'instant' }), /instant liquidity/)
  // …but standard exits of the same size go through (the pool bills them)
  await protocol.requestWithdrawal({ amount: 5n * NANO })
})

test('getStakedBalance values tsTON in GRAM; an undeployed jetton wallet reads as zero', async () => {
  const protocol = new TonstakersProtocolTon(stubAccount(stubClient({ tsTon: 2n * NANO })))
  const position = await protocol.getStakedBalance()
  assert.equal(position.balance, 2n * NANO)
  assert.equal(position.wrappedBalance, 0n)
  const rate = (128685896370406591n * NANO) / 111654561526390897n
  assert.equal(position.rate, rate)
  assert.equal(position.total, (2n * NANO * rate) / NANO)
  const fresh = new TonstakersProtocolTon(stubAccount(stubClient({ walletDeployed: false })))
  assert.equal(await fresh.getTokenBalance(), 0n)
})

test('bills need the off-chain index; claims are honestly unsupported', async () => {
  const protocol = new TonstakersProtocolTon(stubAccount(stubClient()), { endpoints: { tonapi: null, withdrawalPayouts: null } })
  assert.deepEqual(await protocol.getWithdrawalRequests(), { requests: [], pendingAmount: 0n, claimableAmount: 0n, claimableIds: [] })
  await assert.rejects(() => protocol.claimWithdrawals(), /nothing to claim/)
  await assert.rejects(() => protocol.getApr(), /endpoints\.tonapi/)
  assert.equal(await protocol.getRewards(), null)
})

test('clients fail over in order', async () => {
  const dead = Object.create(TonClient.prototype)
  dead.runMethodWithError = async () => { throw new Error('connection refused') }
  dead.getBalance = async () => { throw new Error('connection refused') }
  const protocol = new TonstakersProtocolTon(stubAccount(null), { tonClient: [dead, stubClient({ liquidity: 42n })] })
  assert.equal(await protocol.getInstantLiquidity(), 42n)
  assert.equal((await protocol.getPoolData()).halted, false)
})
