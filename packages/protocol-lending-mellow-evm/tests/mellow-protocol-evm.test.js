'use strict'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AbiCoder, Interface, ZeroAddress, getAddress } from 'ethers'

import MellowProtocolEvm, { MELLOW_ADDRESS_MAP, NATIVE_ASSET, toAsset } from '../index.js'

// Lido EarnUSD as it sits on mainnet (2026-09-07): USDC with async + sync
// deposit queues and an async + a signature redeem queue, USDT with the same
// minus the signature queue, and a third asset with a deposit queue only.
const VAULT = getAddress(MELLOW_ADDRESS_MAP[1]['lido-earn-usd'].vault)
const SHARE_MANAGER = '0x4ce1ac8f43e0e5bd7a346a98af777bf8fbea1981'
const ORACLE = '0x827044735c9708a2cf850e7ea37eba43bc786028'
const FEE_MANAGER = '0x00000000000000000000000000000000000000fe'
const RISK_MANAGER = '0x00000000000000000000000000000000000000f1'
const USDC = getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
const USDT = getAddress('0xdac17f958d2ee523a2206206994597c13d831ec7')
const OTHER = getAddress('0x4c9edd5852cd905f086c759e8383e09bff1e68b3')
const Q = {
  usdcAsync: getAddress('0xc75e7e73b25fea8bb23eb55cc48ba55067b5be76'),
  usdcSync: getAddress('0xf6afaf6afcae116dd37a779d50fe6c5fa6f8c8f5'),
  usdcRedeem: getAddress('0x9e36a74fe278906a76e7615263e46a83fc40c47f'),
  usdcSigRedeem: getAddress('0xe0eee7e956a94bd00546d9ca07e5012f11a5059d'),
  usdtAsync: getAddress('0xeec5041c47cba1e31321ac6941bf09ad60645b73'),
  usdtSync: getAddress('0x534d0beb82c47cf703bfb9e959297658b65ec8e9'),
  usdtRedeem: getAddress('0x95092a7a86715246be6395b8d514b3d60a270cd3'),
  otherAsync: getAddress('0xeec37568b01e0c4d5028501a49e024b475e2d7ca')
}
const OWNER = '0x1111111111111111111111111111111111111111'
const HASH = '0x' + 'ab'.repeat(32)
const E18 = 10n ** 18n
const NOW = Math.floor(Date.now() / 1000)
/** Oracle price: shares per 1 base unit of a 6-decimal asset — 1 USDC ≈ 0.98 shares. */
const PRICE = 980_000_000_000_000_000_000_000_000n

const vaultAbi = new Interface([
  'function shareManager() view returns (address)', 'function feeManager() view returns (address)', 'function oracle() view returns (address)', 'function riskManager() view returns (address)',
  'function getAssetCount() view returns (uint256)', 'function assetAt(uint256) view returns (address)', 'function getQueueCount(address) view returns (uint256)', 'function queueAt(address,uint256) view returns (address)',
  'function hasQueue(address) view returns (bool)', 'function isDepositQueue(address) view returns (bool)', 'function isPausedQueue(address) view returns (bool)'
])
const smAbi = new Interface(['function activeSharesOf(address) view returns (uint256)', 'function claimableSharesOf(address) view returns (uint256)', 'function flags() view returns (bytes)'])
const oracleAbi = new Interface([
  'function getReport(address) view returns ((uint224 priceD18, uint32 timestamp, bool isSuspicious))',
  'function securityParams() view returns ((uint208 absoluteDeviation, uint64 relativeDeviationD18, uint64 suspiciousAbsoluteDeviation, uint64 suspiciousRelativeDeviationD18, uint32 timeout, uint32 depositInterval, uint32 redeemInterval))'
])
const feeAbi = new Interface(['function depositFeeD6() view returns (uint24)', 'function redeemFeeD6() view returns (uint24)', 'function performanceFeeD6() view returns (uint24)', 'function protocolFeeD6() view returns (uint24)'])
const depAbi = new Interface(['function deposit(uint224,address,bytes32[]) payable', 'function cancelDepositRequest()', 'function claimableOf(address) view returns (uint256)', 'function claim(address) returns (bool)', 'function requestOf(address) view returns (uint256,uint256)'])
const redAbi = new Interface(['function redeem(uint256)', 'function requestsOf(address,uint256,uint256) view returns ((uint256 timestamp, uint256 shares, bool isClaimable, uint256 assets)[])', 'function claim(address,uint32[]) returns (uint256)', 'function getState() view returns (uint256,uint256,uint256,uint256)'])
const erc20Abi = new Interface(['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'])
const coder = AbiCoder.defaultAbiCoder()
const sel = (iface, name) => iface.getFunction(name).selector
const enc = (iface, name, values) => iface.encodeFunctionResult(name, values)

const ASSETS = [
  { address: USDC, queues: [{ q: Q.usdcAsync, deposit: true, kind: 'async' }, { q: Q.usdcSync, deposit: true, kind: 'sync' }, { q: Q.usdcRedeem, deposit: false, kind: 'async' }, { q: Q.usdcSigRedeem, deposit: false, kind: 'signature' }] },
  { address: USDT, queues: [{ q: Q.usdtAsync, deposit: true, kind: 'async' }, { q: Q.usdtSync, deposit: true, kind: 'sync' }, { q: Q.usdtRedeem, deposit: false, kind: 'async' }] },
  { address: OTHER, queues: [{ q: Q.otherAsync, deposit: true, kind: 'async' }] }
]
const queueInfo = (address) => ASSETS.flatMap((a) => a.queues).find((x) => x.q.toLowerCase() === address.toLowerCase())

/**
 * An EIP-1193 double of the EarnUSD deployment. Options shape the scenario:
 * report age / suspicious flag, the account's shares and queue state, the
 * allowance, whether the sync deposit proof reverts, whitelist/pause flags.
 */
function stubProvider ({
  shares = 5n * E18, claimable = 0n, allowance = 0n, reportAge = 600, suspicious = false, syncReverts = false,
  paused = [], pendingDeposit = 0n, redeemRequests = [], flags = [0, 0, 0, 0], fees = [0, 0, 150000, 2000], priceD18 = PRICE
} = {}) {
  const calls = []
  const provider = {
    calls,
    async request ({ method, params }) {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x1', blockHash: '0x' + '00'.repeat(32), transactionHash: params[0], logs: [], gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', from: OWNER, to: OWNER, contractAddress: null, index: '0x0', transactionIndex: '0x0', logsBloom: '0x' + '00'.repeat(256), type: '0x2' }
      if (method === 'eth_blockNumber') return '0x10'
      if (method !== 'eth_call') throw new Error(`stub provider: unexpected ${method}`)
      const { to, data, value } = params[0]
      const target = getAddress(to)
      const selector = data.slice(0, 10)
      const arg = (types, offset = 10) => coder.decode(types, '0x' + data.slice(offset))

      if (target === VAULT) {
        if (selector === sel(vaultAbi, 'shareManager')) return enc(vaultAbi, 'shareManager', [SHARE_MANAGER])
        if (selector === sel(vaultAbi, 'feeManager')) return enc(vaultAbi, 'feeManager', [FEE_MANAGER])
        if (selector === sel(vaultAbi, 'oracle')) return enc(vaultAbi, 'oracle', [ORACLE])
        if (selector === sel(vaultAbi, 'riskManager')) return enc(vaultAbi, 'riskManager', [RISK_MANAGER])
        if (selector === sel(vaultAbi, 'getAssetCount')) return enc(vaultAbi, 'getAssetCount', [ASSETS.length])
        if (selector === sel(vaultAbi, 'assetAt')) return enc(vaultAbi, 'assetAt', [ASSETS[Number(arg(['uint256'])[0])].address])
        if (selector === sel(vaultAbi, 'getQueueCount')) return enc(vaultAbi, 'getQueueCount', [ASSETS.find((a) => a.address === getAddress(arg(['address'])[0])).queues.length])
        if (selector === sel(vaultAbi, 'queueAt')) { const [a, i] = arg(['address', 'uint256']); return enc(vaultAbi, 'queueAt', [ASSETS.find((x) => x.address === getAddress(a)).queues[Number(i)].q]) }
        if (selector === sel(vaultAbi, 'hasQueue')) return enc(vaultAbi, 'hasQueue', [!!queueInfo(arg(['address'])[0])])
        if (selector === sel(vaultAbi, 'isDepositQueue')) return enc(vaultAbi, 'isDepositQueue', [!!queueInfo(arg(['address'])[0])?.deposit])
        if (selector === sel(vaultAbi, 'isPausedQueue')) return enc(vaultAbi, 'isPausedQueue', [paused.map((p) => p.toLowerCase()).includes(arg(['address'])[0].toLowerCase())])
      }
      if (target === getAddress(SHARE_MANAGER)) {
        if (selector === sel(smAbi, 'activeSharesOf')) return enc(smAbi, 'activeSharesOf', [shares])
        if (selector === sel(smAbi, 'claimableSharesOf')) return enc(smAbi, 'claimableSharesOf', [claimable])
        if (selector === sel(smAbi, 'flags')) return coder.encode(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'], [...flags, 0, 0])
      }
      if (target === getAddress(ORACLE)) {
        if (selector === sel(oracleAbi, 'getReport')) return enc(oracleAbi, 'getReport', [[priceD18, NOW - reportAge, suspicious]])
        if (selector === sel(oracleAbi, 'securityParams')) return enc(oracleAbi, 'securityParams', [[5n * 10n ** 27n, 10n ** 15n, 5n * 10n ** 15n, 10n ** 15n, 72000, 3600, 172800]])
      }
      if (target === getAddress(FEE_MANAGER)) {
        const names = ['depositFeeD6', 'redeemFeeD6', 'performanceFeeD6', 'protocolFeeD6']
        for (let i = 0; i < 4; i++) if (selector === sel(feeAbi, names[i])) return enc(feeAbi, names[i], [fees[i]])
      }
      if (target === USDC || target === USDT) {
        if (selector === sel(erc20Abi, 'allowance')) return enc(erc20Abi, 'allowance', [allowance])
      }
      const q = queueInfo(target)
      if (q) {
        if (q.deposit) {
          if (selector === sel(depAbi, 'requestOf')) {
            if (q.kind !== 'async') throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x' })
            return enc(depAbi, 'requestOf', [pendingDeposit > 0n ? NOW - 100 : 0, pendingDeposit])
          }
          if (selector === sel(depAbi, 'claimableOf')) return enc(depAbi, 'claimableOf', [claimable])
          if (selector === sel(depAbi, 'deposit')) {
            if (q.kind === 'sync' && syncReverts) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x' })
            return '0x'
          }
        } else {
          if (selector === sel(redAbi, 'requestsOf')) {
            if (q.kind !== 'async') throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x' })
            return enc(redAbi, 'requestsOf', [redeemRequests.filter((r) => r.queue === q.q).map((r) => [r.timestamp, r.shares, r.claimable, r.assets])])
          }
          if (selector === sel(redAbi, 'redeem')) return '0x'
        }
      }
      throw Object.assign(new Error(`stub provider: unexpected call ${selector} to ${target} (value ${value ?? 0})`), { code: 'CALL_EXCEPTION', data: '0x' })
    }
  }
  return provider
}

function stubAccount (provider, { readOnly = false } = {}) {
  const sent = []
  const account = { sent, _config: { provider }, async getAddress () { return OWNER } }
  if (!readOnly) {
    account.sendTransaction = async (tx) => { sent.push(tx); return { hash: HASH, fee: 21_000n } }
    account.quoteSendTransaction = async () => ({ fee: 21_000n })
  }
  return account
}

const protocolFor = (opts = {}, { readOnly = false, config = {} } = {}) => {
  const provider = stubProvider(opts)
  return new MellowProtocolEvm(stubAccount(provider, { readOnly }), { preset: 'lido-earn-usd', registry: null, ...config })
}

// ---- construction ----

test('constructor: preset or vault address, unknown preset refused, reads need a provider', async () => {
  assert.equal(new MellowProtocolEvm({}, { preset: 'lido-earn-eth', provider: 'http://x' }).vault, getAddress(MELLOW_ADDRESS_MAP[1]['lido-earn-eth'].vault))
  assert.equal(new MellowProtocolEvm({}, { vault: VAULT.toLowerCase(), provider: 'http://x' }).vault, VAULT)
  assert.throws(() => new MellowProtocolEvm({}, { preset: 'nope' }), /Unknown Mellow preset/)
  for (const key of Object.keys(MELLOW_ADDRESS_MAP[1])) assert.equal(new MellowProtocolEvm({}, { preset: key, provider: 'http://x' }).vault, getAddress(MELLOW_ADDRESS_MAP[1][key].vault))
  assert.throws(() => new MellowProtocolEvm({}, {}), /'vault' must be/)
  await assert.rejects(() => new MellowProtocolEvm({ async getAddress () { return OWNER } }, { vault: VAULT }).getVaultData(), /provider/)
  assert.equal(toAsset('native'), NATIVE_ASSET)
  assert.equal(toAsset(ZeroAddress), NATIVE_ASSET)
  assert.equal(toAsset(USDC.toLowerCase()), USDC)
  assert.throws(() => toAsset('0x12'), /'token'/)
})

// ---- discovery ----

test('getVaultData discovers components, assets and queues on-chain and classifies each queue by its methods', async () => {
  const p = protocolFor()
  const data = await p.getVaultData()
  assert.equal(getAddress(data.shareManager), getAddress(SHARE_MANAGER))
  assert.equal(getAddress(data.oracle), getAddress(ORACLE))
  assert.equal(data.assets.length, 3)
  const usdc = data.assets.find((a) => a.address === USDC)
  assert.deepEqual(usdc.depositQueues.map((q) => q.kind), ['async', 'sync'])
  assert.deepEqual(usdc.redeemQueues.map((q) => q.kind), ['async', 'signature'])
  assert.equal(data.assets.find((a) => a.address === OTHER).redeemQueues.length, 0)
  assert.deepEqual(data.fees, { depositPct: 0, redeemPct: 0, performancePct: 15, protocolPct: 0.2 })
  assert.deepEqual(data.oracleParams, { timeout: 72000, depositInterval: 3600, redeemInterval: 172800 })
  assert.deepEqual(data.flags, { hasWhitelist: false, hasMintPause: false, hasBurnPause: false })
  const flagged = await protocolFor({ flags: [1, 0, 0, 1] }).getVaultData()
  assert.deepEqual(flagged.flags, { hasWhitelist: true, hasMintPause: true, hasBurnPause: false })
})

// ---- position ----

test('getPosition values shares at the report and lists queue state', async () => {
  const p = protocolFor({ shares: 5n * E18, claimable: 7n, pendingDeposit: 25_000_000n, redeemRequests: [{ queue: Q.usdcRedeem, timestamp: NOW - 5000, shares: E18, claimable: true, assets: 1_020_000n }] })
  const pos = await p.getPosition({ token: USDC })
  assert.equal(pos.shares, 5n * E18)
  assert.equal(pos.token, USDC)
  assert.equal(pos.value, (5n * E18 * E18) / PRICE) // ≈ 5.1 USDC
  assert.equal(pos.claimableShares, 7n * 3n) // one async deposit queue per asset
  assert.equal(pos.pendingDeposits.length, 3)
  assert.equal(pos.redeemRequests.length, 1)
  assert.equal(pos.redeemRequests[0].claimable, true)
})

// ---- supply ----

test('supply USDC: approve (awaited) then deposit on the sync queue when the proof passes', async () => {
  const provider = stubProvider({ allowance: 0n })
  const account = stubAccount(provider)
  const p = new MellowProtocolEvm(account, { preset: 'lido-earn-usd', registry: null })
  const r = await p.supply({ token: USDC, amount: 10_000_000n })
  assert.equal(r.hash, HASH)
  assert.equal(r.instant, true)
  assert.equal(getAddress(r.queue), Q.usdcSync)
  assert.equal(account.sent.length, 2)
  assert.equal(getAddress(account.sent[0].to), USDC)
  assert.equal(account.sent[0].data.slice(0, 10), sel(erc20Abi, 'approve'))
  const dep = account.sent[1]
  assert.equal(getAddress(dep.to), Q.usdcSync)
  assert.equal(dep.value, 0n)
  const decoded = depAbi.decodeFunctionData('deposit', dep.data)
  assert.equal(decoded[0], 10_000_000n)
  assert.equal(decoded[1], ZeroAddress)
  assert.equal(r.fee, 42_000n)
  assert.deepEqual(r.approveHashes, [HASH])
})

test('supply falls back to the async queue when the sync proof reverts; USDT allowance resets to zero first', async () => {
  const provider = stubProvider({ allowance: 5n, syncReverts: true })
  const account = stubAccount(provider)
  const p = new MellowProtocolEvm(account, { preset: 'lido-earn-usd', registry: null })
  const r = await p.supply({ token: USDT, amount: 10_000_000n })
  assert.equal(r.instant, false)
  assert.equal(getAddress(r.queue), Q.usdtAsync)
  assert.equal(account.sent.length, 3) // approve 0, approve amount, deposit
  assert.equal(erc20Abi.decodeFunctionData('approve', account.sent[0].data)[1], 0n)
  assert.equal(erc20Abi.decodeFunctionData('approve', account.sent[1].data)[1], 10_000_000n)
  assert.equal(getAddress(account.sent[2].to), Q.usdtAsync)
  // A quote cannot prove the sync deposit while the allowance is still pending:
  // it stays optimistic on a fresh report and turns async on a stale one.
  const quote = await p.quoteSupply({ token: USDT, amount: 10_000_000n })
  assert.equal(quote.instant, true)
  assert.equal(quote.sharesOut, (10_000_000n * PRICE) / E18)
  assert.equal(quote.fee, 63_000n)
  const stale = await protocolFor({ allowance: 5n, reportAge: 80_000 }).quoteSupply({ token: USDT, amount: 10_000_000n })
  assert.equal(stale.instant, false)
  assert.equal(getAddress(stale.queue), Q.usdtAsync)
})

test('supply guards: unknown asset, open async request, suspicious report, whitelist, mint pause, read-only, onBehalfOf', async () => {
  await assert.rejects(() => protocolFor().supply({ token: OWNER, amount: 1n }), /does not accept/)
  await assert.rejects(() => protocolFor({ syncReverts: true, pendingDeposit: 1n }).supply({ token: USDC, amount: 1n }), /open deposit request/)
  await assert.rejects(() => protocolFor({ suspicious: true }).supply({ token: USDC, amount: 1n }), /suspicious/)
  await assert.rejects(() => protocolFor({ flags: [0, 0, 0, 1] }).supply({ token: USDC, amount: 1n }), /whitelist/)
  await assert.rejects(() => protocolFor({ flags: [1, 0, 0, 0] }).supply({ token: USDC, amount: 1n }), /minting paused/)
  await assert.rejects(() => protocolFor({}, { readOnly: true }).supply({ token: USDC, amount: 1n }), /non read-only/)
  await assert.rejects(() => protocolFor().supply({ token: USDC, amount: 1n, onBehalfOf: OWNER }), /onBehalfOf/)
  await assert.rejects(() => protocolFor().supply({ token: USDC, amount: 0n }), /greater than zero/)
  await assert.rejects(() => protocolFor({ paused: [Q.usdcSync, Q.usdcAsync] }).supply({ token: USDC, amount: 1n }), /no open deposit queue/)
})

test('cancelSupply and claimShares target the async deposit queue', async () => {
  const provider = stubProvider({ pendingDeposit: 5n })
  const account = stubAccount(provider)
  const p = new MellowProtocolEvm(account, { preset: 'lido-earn-usd', registry: null })
  await p.cancelSupply({ token: USDC })
  assert.equal(getAddress(account.sent[0].to), Q.usdcAsync)
  assert.equal(account.sent[0].data, depAbi.encodeFunctionData('cancelDepositRequest', []))
  await p.claimShares({ token: USDT })
  assert.equal(getAddress(account.sent[1].to), Q.usdtAsync)
  assert.equal(account.sent[1].data, depAbi.encodeFunctionData('claim', [OWNER]))
  await assert.rejects(() => protocolFor().cancelSupply({ token: USDC }), /No open deposit request/)
})

// ---- withdraw ----

test('withdraw redeems shares on the async redeem queue of the payout asset and quotes the payout', async () => {
  const provider = stubProvider({ shares: 5n * E18 })
  const account = stubAccount(provider)
  const p = new MellowProtocolEvm(account, { preset: 'lido-earn-usd', registry: null })
  const r = await p.withdraw({ token: USDC, amount: 2n * E18 })
  assert.equal(getAddress(r.queue), Q.usdcRedeem) // not the signature queue
  assert.equal(getAddress(account.sent[0].to), Q.usdcRedeem)
  assert.equal(redAbi.decodeFunctionData('redeem', account.sent[0].data)[0], 2n * E18)
  assert.equal(r.assetsOut, (2n * E18 * E18) / PRICE)
  const q = await p.quoteWithdraw({ token: USDT, amount: E18 })
  assert.equal(getAddress(q.queue), Q.usdtRedeem)
  assert.equal(q.fee, 21_000n)
})

test('withdraw guards: over the balance, no redeem queue for the asset, paused, burn pause, suspicious, to', async () => {
  await assert.rejects(() => protocolFor({ shares: E18 }).withdraw({ token: USDC, amount: 2n * E18 }), /exceeds the account's shares/)
  await assert.rejects(() => protocolFor().withdraw({ token: OTHER, amount: 1n }), /no open redeem queue/)
  await assert.rejects(() => protocolFor({ paused: [Q.usdcRedeem] }).withdraw({ token: USDC, amount: 1n }), /no open redeem queue/)
  await assert.rejects(() => protocolFor({ flags: [0, 1, 0, 0] }).withdraw({ token: USDC, amount: 1n }), /redemptions paused/)
  await assert.rejects(() => protocolFor({ suspicious: true }).withdraw({ token: USDC, amount: 1n }), /suspicious/)
  await assert.rejects(() => protocolFor().withdraw({ token: USDC, amount: 1n, to: OWNER }), /'to'/)
})

test('getWithdrawalRequests groups claimable requests per queue; claimWithdrawals claims them, one transaction per asset', async () => {
  const redeemRequests = [
    { queue: Q.usdcRedeem, timestamp: NOW - 9000, shares: E18, claimable: true, assets: 1_020_000n },
    { queue: Q.usdcRedeem, timestamp: NOW - 8000, shares: E18, claimable: true, assets: 1_030_000n },
    { queue: Q.usdcRedeem, timestamp: NOW - 100, shares: E18, claimable: false, assets: 0n },
    { queue: Q.usdtRedeem, timestamp: NOW - 7000, shares: E18 / 2n, claimable: true, assets: 500_000n }
  ]
  const provider = stubProvider({ redeemRequests })
  const account = stubAccount(provider)
  const p = new MellowProtocolEvm(account, { preset: 'lido-earn-usd', registry: null })
  const view = await p.getWithdrawalRequests()
  assert.equal(view.requests.length, 4)
  assert.equal(view.requests[0].timestamp, NOW - 100) // newest first
  assert.equal(view.pendingShares, E18)
  assert.equal(view.claimable.length, 2)
  const usdc = view.claimable.find((c) => c.token === USDC)
  assert.equal(usdc.assets, 2_050_000n)
  assert.deepEqual(usdc.timestamps, [NOW - 8000, NOW - 9000])

  const all = await p.claimWithdrawals()
  assert.equal(all.hashes.length, 2)
  assert.equal(account.sent.length, 2)
  const usdcClaim = account.sent.find((t) => getAddress(t.to) === Q.usdcRedeem)
  const [receiver, ts] = redAbi.decodeFunctionData('claim', usdcClaim.data)
  assert.equal(receiver, OWNER)
  assert.deepEqual(ts.map(Number), [NOW - 8000, NOW - 9000])
  assert.deepEqual(all.assets.map((a) => a.amount).sort((a, b) => (a < b ? -1 : 1)), [500_000n, 2_050_000n])

  const one = await p.claimWithdrawals({ token: USDC, timestamps: [NOW - 9000] })
  assert.equal(one.hashes.length, 1)
  assert.deepEqual(redAbi.decodeFunctionData('claim', account.sent[2].data)[1].map(Number), [NOW - 9000])
  await assert.rejects(() => protocolFor().claimWithdrawals(), /Nothing is claimable/)
})

// ---- not lending ----

test('borrow and repay reject with NotImplementedError', async () => {
  const p = protocolFor()
  for (const m of ['borrow', 'quoteBorrow', 'repay', 'quoteRepay']) {
    await assert.rejects(() => p[m]({ token: USDC, amount: 1n }), (e) => e.name === 'NotImplementedError' && /do not lend/.test(e.message))
  }
})

// ---- registry ----

test('getStats / getApr read the registry by vault address; null / rejection without it', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: 'lido-earn-usd', name: 'Lido EarnUSD', address: VAULT.toLowerCase(), apy: 7.78, tvl_usd: 30_600_000, withdraw_avg_time_seconds: 40_000 }] })
  try {
    const p = protocolFor({}, { config: { registry: 'https://example.invalid/vaults' } })
    assert.deepEqual(await p.getStats(), { id: 'lido-earn-usd', name: 'Lido EarnUSD', apy: 7.78, tvlUsd: 30_600_000, withdrawAvgSeconds: 40_000 })
    assert.equal(await p.getApr(), 7.78)
  } finally {
    globalThis.fetch = orig
  }
  assert.equal(await protocolFor().getStats(), null)
  await assert.rejects(() => protocolFor().getApr(), /registry/)
})
