'use strict'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Interface } from 'ethers'

import LidoProtocolEvm, { StakingProtocol, splitWithdrawalAmounts } from '../index.js'

const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84'
const WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'
const QUEUE = '0x889edc2edab5f40e902b864ad4d7ade8e412f9b1'
const OWNER = '0x1111111111111111111111111111111111111111'
const E18 = 10n ** 18n

const erc20 = new Interface([
  'function nonces(address _owner) view returns (uint256)',
  'function allowance(address _owner, address _spender) view returns (uint256)',
  'function approve(address _spender, uint256 _amount) returns (bool)',
  'function isStakingPaused() view returns (bool)',
  'function getCurrentStakeLimit() view returns (uint256)',
  'function submit(address _referral) payable returns (uint256)'
])
const queueAbi = new Interface([
  'function requestWithdrawals(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function requestWithdrawalsWstETH(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWstETHWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function getWithdrawalRequests(address _owner) view returns (uint256[])'
])

const SIG = '0x' + '12'.repeat(32) + '34'.repeat(32) + '1b'

/** Minimal EIP-1193 provider answering the calls this module makes. */
function stubEip1193 ({ allowance = 0n } = {}) {
  return {
    async request ({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_call') {
        const { data } = params[0]
        const selector = data.slice(0, 10)
        if (selector === erc20.getFunction('nonces').selector) {
          return erc20.encodeFunctionResult('nonces', [0n])
        }
        if (selector === erc20.getFunction('allowance').selector) {
          return erc20.encodeFunctionResult('allowance', [allowance])
        }
        if (selector === erc20.getFunction('isStakingPaused').selector) {
          return erc20.encodeFunctionResult('isStakingPaused', [false])
        }
        if (selector === erc20.getFunction('getCurrentStakeLimit').selector) {
          return erc20.encodeFunctionResult('getCurrentStakeLimit', [150000n * E18])
        }
        if (selector === queueAbi.getFunction('getWithdrawalRequests').selector) {
          return queueAbi.encodeFunctionResult('getWithdrawalRequests', [[]])
        }
        return '0x' // the permit-proof call just needs to not revert
      }
      throw new Error(`stub provider: unexpected method ${method}`)
    }
  }
}

function stubAccount (provider, { signTypedData } = {}) {
  const sent = []
  return {
    sent,
    typedDataCalls: [],
    async getAddress () { return OWNER },
    async signTypedData (typedData) {
      this.typedDataCalls.push(typedData)
      if (signTypedData) return signTypedData(typedData)
      return SIG
    },
    async sendTransaction (tx) {
      sent.push(tx)
      return { hash: '0x' + 'ab'.repeat(32), fee: 5n }
    },
    async quoteSendTransaction (tx) { return { fee: 3n } },
    _config: { provider }
  }
}

test('the base class throws NotImplementedError on every method', async () => {
  const base = new StakingProtocol({})
  for (const method of ['stake', 'quoteStake', 'requestWithdrawal', 'quoteRequestWithdrawal', 'getWithdrawalRequests', 'claimWithdrawals', 'quoteClaimWithdrawals', 'getStakedBalance', 'getApr']) {
    await assert.rejects(() => base[method]({ amount: 1n }), (err) => err.name === 'NotImplementedError')
  }
})

test('splitWithdrawalAmounts splits over-cap amounts into caps plus remainder', () => {
  assert.deepEqual(splitWithdrawalAmounts(5n, 10n), [5n])
  assert.deepEqual(splitWithdrawalAmounts(10n, 10n), [10n])
  assert.deepEqual(splitWithdrawalAmounts(25n, 10n), [10n, 10n, 5n])
})

test('constructor refuses unknown chains without explicit addresses', () => {
  assert.throws(() => new LidoProtocolEvm({}, { chainId: 560048 }), /addresses/)
  assert.throws(() => new LidoProtocolEvm({}, { referral: 'not-an-address' }), /referral/)
})

test('amount validation and the writable-account gate', async () => {
  const protocol = new LidoProtocolEvm(stubAccount(stubEip1193()))
  await assert.rejects(() => protocol.stake({ amount: 0n }), /greater than zero/)
  await assert.rejects(() => protocol.stake({ amount: 1.5 }), /bigint or a safe integer/)
  await assert.rejects(() => protocol.requestWithdrawal({ amount: 1n, token: 'wETH' }), /'stETH' or 'wstETH'/)

  const readOnly = new LidoProtocolEvm({ async getAddress () { return OWNER }, _config: { provider: stubEip1193() } })
  await assert.rejects(() => readOnly.stake({ amount: 1n }), /non read-only/)
})

test('stake submits with the configured referral', async () => {
  const referral = '0x2222222222222222222222222222222222222222'
  const account = stubAccount(stubEip1193())
  const protocol = new LidoProtocolEvm(account, { referral })
  const result = await protocol.stake({ amount: E18 })
  assert.equal(result.hash, '0x' + 'ab'.repeat(32))
  assert.equal(account.sent.length, 1)
  assert.equal(account.sent[0].to.toLowerCase(), STETH)
  assert.equal(account.sent[0].value, E18)
  const decoded = erc20.decodeFunctionData('submit', account.sent[0].data)
  assert.equal(decoded[0].toLowerCase(), referral)
})

test('requestWithdrawal goes permit-first: one transaction, no approval', async () => {
  const account = stubAccount(stubEip1193())
  const protocol = new LidoProtocolEvm(account)
  const result = await protocol.requestWithdrawal({ amount: E18 })
  assert.equal(result.approveHash, null)
  assert.equal(account.sent.length, 1)
  assert.equal(account.sent[0].to.toLowerCase(), QUEUE)
  const decoded = queueAbi.decodeFunctionData('requestWithdrawalsWithPermit', account.sent[0].data)
  assert.deepEqual([...decoded[0]], [E18])
  assert.equal(decoded[1].toLowerCase(), OWNER)
  // and the permit was signed against the verified stETH domain
  const typed = account.typedDataCalls[0]
  assert.equal(typed.domain.name, 'Liquid staked Ether 2.0')
  assert.equal(typed.domain.version, '2')
  assert.equal(typed.message.spender.toLowerCase(), QUEUE)
})

test('requestWithdrawal falls back to plain request when the permit leg fails and allowance suffices', async () => {
  const account = stubAccount(stubEip1193({ allowance: 10n * E18 }), {
    signTypedData: () => { throw new Error('user rejected') }
  })
  const protocol = new LidoProtocolEvm(account)
  const result = await protocol.requestWithdrawal({ amount: E18 })
  assert.equal(result.approveHash, null)
  assert.equal(account.sent.length, 1)
  const decoded = queueAbi.decodeFunctionData('requestWithdrawals', account.sent[0].data)
  assert.deepEqual([...decoded[0]], [E18])
})

test('wstETH withdrawals use the wstETH queue entrypoints, domain and 800-token cap', async () => {
  const account = stubAccount(stubEip1193())
  const protocol = new LidoProtocolEvm(account)
  await protocol.requestWithdrawal({ amount: 1600n * E18, token: 'wstETH' })
  const decoded = queueAbi.decodeFunctionData('requestWithdrawalsWstETHWithPermit', account.sent[0].data)
  assert.deepEqual([...decoded[0]], [800n * E18, 800n * E18])
  const typed = account.typedDataCalls[0]
  assert.equal(typed.domain.name, 'Wrapped liquid staked Ether 2.0')
  assert.equal(typed.domain.version, '1')
  assert.equal(typed.domain.verifyingContract.toLowerCase(), WSTETH)
})

test('an empty queue reads back as an empty view', async () => {
  const protocol = new LidoProtocolEvm(stubAccount(stubEip1193()))
  const view = await protocol.getWithdrawalRequests()
  assert.deepEqual(view, { requests: [], pendingAmount: 0n, claimableAmount: 0n, claimableIds: [] })
})

test('claimWithdrawals refuses when nothing is claimable', async () => {
  const protocol = new LidoProtocolEvm(stubAccount(stubEip1193()))
  await assert.rejects(() => protocol.claimWithdrawals(), /no claimable/)
})
