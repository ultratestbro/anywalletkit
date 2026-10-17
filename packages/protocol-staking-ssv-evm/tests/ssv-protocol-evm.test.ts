import assert from 'node:assert/strict'
import { test } from 'vitest'
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, parseAbi, toFunctionSelector, type Hex } from 'viem'

import SsvProtocolEvm, { StakingProtocol, describeRevert, SSV_ADDRESS_MAP, ETH_CLAIM_UNIT } from '../src/index.js'

const { network: NETWORK, views: VIEWS, ssvToken: SSV } = SSV_ADDRESS_MAP[1]!
const OWNER = '0x1111111111111111111111111111111111111111'
const E18 = 10n ** 18n
const HASH = `0x${'ab'.repeat(32)}` as const

const erc20 = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const views = parseAbi([
  'function cooldownDuration() view returns (uint256)',
  'function stakedBalanceOf(address user) view returns (uint256)',
  'function previewClaimableEth(address user) view returns (uint256)',
  'function pendingUnstake(address user) view returns ((uint256 amount, uint256 unlockTime)[])',
])
const network = parseAbi([
  'function stake(uint256 amount)',
  'function requestUnstake(uint256 amount)',
  'function withdrawUnlocked()',
  'function claimEthRewards()',
])

const SEL = {
  allowance: toFunctionSelector('function allowance(address owner, address spender) view returns (uint256)'),
  balanceOf: toFunctionSelector('function balanceOf(address owner) view returns (uint256)'),
  cooldownDuration: toFunctionSelector('function cooldownDuration() view returns (uint256)'),
  stakedBalanceOf: toFunctionSelector('function stakedBalanceOf(address user) view returns (uint256)'),
  previewClaimableEth: toFunctionSelector('function previewClaimableEth(address user) view returns (uint256)'),
  pendingUnstake: toFunctionSelector('function pendingUnstake(address user) view returns ((uint256 amount, uint256 unlockTime)[])'),
}

const NOW = Math.floor(Date.now() / 1000)
const COOLDOWN = 604800n

interface StubOptions {
  allowance?: bigint
  staked?: bigint
  claimable?: bigint
  pending?: Array<{ amount: bigint; unlockTime: bigint }>
  revert?: Hex | null
}

/** Minimal EIP-1193 provider answering the calls this module makes. */
function stubEip1193({ allowance = 0n, staked = 0n, claimable = 0n, pending = [], revert = null }: StubOptions = {}) {
  const calls: Array<{ to: string; data: Hex }> = []
  return {
    calls,
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_blockNumber') return '0x10'
      if (method === 'eth_getTransactionReceipt') {
        const [hash] = params as [Hex]
        return {
          blockHash: `0x${'11'.repeat(32)}`, blockNumber: '0x10', transactionHash: hash, transactionIndex: '0x0', hash, index: '0x0',
          from: OWNER, to: SSV, gasUsed: '0x5208', cumulativeGasUsed: '0x5208', gasPrice: '0x1', effectiveGasPrice: '0x1',
          logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2', contractAddress: null, root: null,
        }
      }
      if (method === 'eth_call') {
        const [{ to, data }] = params as [{ to: string; data: Hex }]
        calls.push({ to: to.toLowerCase(), data })
        const selector = data.slice(0, 10)
        if (to.toLowerCase() === SSV.toLowerCase()) {
          if (selector === SEL.allowance) return encodeFunctionResult({ abi: erc20, functionName: 'allowance', result: allowance })
          if (selector === SEL.balanceOf) return encodeFunctionResult({ abi: erc20, functionName: 'balanceOf', result: 5n * E18 })
        }
        if (to.toLowerCase() === VIEWS.toLowerCase()) {
          if (selector === SEL.cooldownDuration) return encodeFunctionResult({ abi: views, functionName: 'cooldownDuration', result: COOLDOWN })
          if (selector === SEL.stakedBalanceOf) return encodeFunctionResult({ abi: views, functionName: 'stakedBalanceOf', result: staked })
          if (selector === SEL.previewClaimableEth) return encodeFunctionResult({ abi: views, functionName: 'previewClaimableEth', result: claimable })
          if (selector === SEL.pendingUnstake) return encodeFunctionResult({ abi: views, functionName: 'pendingUnstake', result: pending })
        }
        if (to.toLowerCase() === NETWORK.toLowerCase()) {
          if (revert) {
            // The shape a node reports a revert in: JSON-RPC code 3 with the revert bytes in `data`.
            throw Object.assign(new Error('execution reverted'), { code: 3, data: revert })
          }
          return '0x' // the proof call just needs to not revert
        }
        throw new Error(`stub provider: unexpected eth_call ${to} ${selector}`)
      }
      throw new Error(`stub provider: unexpected method ${method}`)
    },
  }
}

type SentTx = { to: string; data?: string; value?: bigint }

function stubAccount(provider: ReturnType<typeof stubEip1193>) {
  const sent: SentTx[] = []
  return {
    sent,
    async getAddress() { return OWNER },
    async sendTransaction(tx: SentTx) {
      sent.push(tx)
      return { hash: HASH, fee: 5n }
    },
    async quoteSendTransaction() { return { fee: 3n } },
    _config: { provider },
  }
}

const data = (tx: SentTx | undefined): Hex => tx!.data as Hex

test('the base class throws NotImplementedError on every method', async () => {
  const base = new StakingProtocol({} as never) as unknown as Record<string, (o: unknown) => Promise<unknown>>
  for (const method of ['stake', 'quoteStake', 'requestWithdrawal', 'quoteRequestWithdrawal', 'getWithdrawalRequests', 'claimWithdrawals', 'quoteClaimWithdrawals', 'getStakedBalance', 'getApr']) {
    await assert.rejects(() => base[method]!({ amount: 1n }), (err: unknown) => (err as Error).name === 'NotImplementedError')
  }
})

test('constructor refuses unknown chains without explicit addresses', () => {
  assert.throws(() => new SsvProtocolEvm({} as never, { chainId: 560048 }), /addresses/)
  assert.throws(() => new SsvProtocolEvm({} as never, { chainId: 560048, addresses: { network: '0x1' } }), /addresses\.views/)
})

test('amount validation and the writable-account gate', async () => {
  const protocol = new SsvProtocolEvm(stubAccount(stubEip1193()))
  await assert.rejects(() => protocol.stake({ amount: 0n }), /greater than zero/)
  await assert.rejects(() => protocol.stake({ amount: 1.5 }), /bigint or a safe integer/)
  await assert.rejects(() => protocol.stake({ amount: 1n }), /StakeTooLow/)

  const readOnly = new SsvProtocolEvm({ async getAddress() { return OWNER }, _config: { provider: stubEip1193() } })
  await assert.rejects(() => readOnly.stake({ amount: E18 }), /non read-only/)
  await assert.rejects(() => readOnly.claimRewards(), /non read-only/)
})

test('stake with a sufficient allowance is one proven transaction', async () => {
  const provider = stubEip1193({ allowance: 10n * E18 })
  const account = stubAccount(provider)
  const protocol = new SsvProtocolEvm(account)
  const result = await protocol.stake({ amount: E18 })
  assert.equal(result.hash, HASH)
  assert.equal(result.approveHash, null)
  assert.equal(result.fee, 5n)
  assert.equal(account.sent.length, 1)
  assert.equal(account.sent[0]!.to.toLowerCase(), NETWORK.toLowerCase())
  const decoded = decodeFunctionData({ abi: network, data: data(account.sent[0]) })
  assert.equal(decoded.functionName, 'stake')
  assert.equal(decoded.args[0], E18)
  // proven with eth_call against the network before signing
  assert.ok(provider.calls.some((c) => c.to === NETWORK.toLowerCase() && c.data === account.sent[0]!.data))
})

test('stake with a short allowance approves first, awaits the receipt, then stakes', async () => {
  const account = stubAccount(stubEip1193({ allowance: 0n }))
  const protocol = new SsvProtocolEvm(account)
  const result = await protocol.stake({ amount: E18 })
  assert.equal(result.approveHash, HASH)
  assert.equal(result.fee, 10n)
  assert.equal(account.sent.length, 2)
  assert.equal(account.sent[0]!.to.toLowerCase(), SSV.toLowerCase())
  const approve = decodeFunctionData({ abi: erc20, data: data(account.sent[0]) })
  assert.equal(approve.functionName, 'approve')
  assert.equal((approve.args[0] as string).toLowerCase(), NETWORK.toLowerCase())
  assert.equal(approve.args[1], E18)
  assert.equal(account.sent[1]!.to.toLowerCase(), NETWORK.toLowerCase())
})

test('a revert in the proof surfaces as the named custom error and nothing is sent', async () => {
  const account = stubAccount(stubEip1193({ allowance: 10n * E18, revert: '0x02a19f57' }))
  const protocol = new SsvProtocolEvm(account)
  await assert.rejects(() => protocol.requestWithdrawal({ amount: E18 }), /UnstakeAmountExceedsBalance/)
  assert.equal(account.sent.length, 0)
})

test('describeRevert finds the selector in data, nested info.error.data, and message text', () => {
  assert.match(describeRevert(Object.assign(new Error('x'), { data: '0xd0d04f60' })).message, /NothingToWithdraw/)
  assert.match(describeRevert(Object.assign(new Error('x'), { info: { error: { data: '0x969bf728' } } })).message, /NothingToClaim/)
  assert.match(describeRevert(new Error('reverted with signature 0x1cc3b37b')).message, /StakeTooLow/)
  assert.equal(describeRevert(new Error('something else')).message, 'something else')
})

test('requestWithdrawal burns cSSV into a cooldown entry without approval', async () => {
  const account = stubAccount(stubEip1193())
  const protocol = new SsvProtocolEvm(account)
  const result = await protocol.requestWithdrawal({ amount: E18, token: 'whatever' })
  assert.equal(result.approveHash, null)
  assert.equal(account.sent.length, 1)
  const decoded = decodeFunctionData({ abi: network, data: data(account.sent[0]) })
  assert.equal(decoded.functionName, 'requestUnstake')
  assert.equal(decoded.args[0], E18)
})

test('getWithdrawalRequests maps cooldown entries: ids are positions, claimable once unlocked', async () => {
  const pending = [
    { amount: 2n * E18, unlockTime: BigInt(NOW - 60) }, // unlocked
    { amount: 3n * E18, unlockTime: BigInt(NOW + 3600) }, // cooling down
  ]
  const protocol = new SsvProtocolEvm(stubAccount(stubEip1193({ pending })))
  const view = await protocol.getWithdrawalRequests()
  assert.equal(view.requests.length, 2)
  assert.equal(view.pendingAmount, 3n * E18)
  assert.equal(view.claimableAmount, 2n * E18)
  assert.deepEqual(view.claimableIds, [0n])
  const ready = view.requests.find((r) => r.id === 0n)!
  assert.equal(ready.claimable, true)
  assert.equal(ready.unlockTime, NOW - 60)
  assert.equal(ready.timestamp, NOW - 60 - Number(COOLDOWN))
  // latest unlock first
  assert.equal(view.requests[0]!.id, 1n)
})

test('an empty cooldown list reads back as an empty view', async () => {
  const protocol = new SsvProtocolEvm(stubAccount(stubEip1193()))
  const view = await protocol.getWithdrawalRequests()
  assert.deepEqual(view, { requests: [], pendingAmount: 0n, claimableAmount: 0n, claimableIds: [] })
})

test('claimWithdrawals refuses when nothing is unlocked and pays everything otherwise', async () => {
  await assert.rejects(() => new SsvProtocolEvm(stubAccount(stubEip1193())).claimWithdrawals(), /no claimable/)
  const account = stubAccount(stubEip1193({ pending: [{ amount: E18, unlockTime: BigInt(NOW - 1) }] }))
  const result = await new SsvProtocolEvm(account).claimWithdrawals({ ids: [0n] })
  assert.equal(result.hash, HASH)
  assert.equal(account.sent[0]!.data, encodeFunctionData({ abi: network, functionName: 'withdrawUnlocked' }))
})

test('rewards: claimable below the rounding unit is refused, above it claims', async () => {
  await assert.rejects(() => new SsvProtocolEvm(stubAccount(stubEip1193({ claimable: ETH_CLAIM_UNIT - 1n }))).claimRewards(), /NothingToClaim/)
  const account = stubAccount(stubEip1193({ claimable: ETH_CLAIM_UNIT }))
  const protocol = new SsvProtocolEvm(account)
  assert.equal(await protocol.getClaimableRewards(), ETH_CLAIM_UNIT)
  await protocol.claimRewards()
  assert.equal(account.sent[0]!.data, encodeFunctionData({ abi: network, functionName: 'claimEthRewards' }))
})

test('getStakedBalance reports cSSV 1:1 and getTokenBalance the liquid SSV', async () => {
  const protocol = new SsvProtocolEvm(stubAccount(stubEip1193({ staked: 7n * E18 })))
  assert.deepEqual(await protocol.getStakedBalance(), { balance: 7n * E18, wrappedBalance: 0n, rate: E18, total: 7n * E18 })
  assert.equal(await protocol.getTokenBalance(), 5n * E18)
  assert.equal(await protocol.getCooldown(), Number(COOLDOWN))
})
