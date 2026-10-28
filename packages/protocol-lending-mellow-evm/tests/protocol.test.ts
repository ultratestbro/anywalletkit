import { describe, expect, it } from 'vitest'
import {
  decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAbiItem, getAddress, parseAbi, toFunctionSelector, zeroAddress,
  type Abi, type AbiFunction, type Address, type Hex,
} from 'viem'

import MellowProtocolEvm, { MELLOW_ADDRESS_MAP, NATIVE_ASSET, toAsset, type MellowAccount } from '../src/index.js'

// Lido EarnUSD as it sits on mainnet (2026-09-07): USDC with async + sync
// deposit queues and an async + a signature redeem queue, USDT with the same
// minus the signature queue, and a third asset with a deposit queue only.
const VAULT = getAddress(MELLOW_ADDRESS_MAP[1]!['lido-earn-usd']!.vault)
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
  otherAsync: getAddress('0xeec37568b01e0c4d5028501a49e024b475e2d7ca'),
}
const OWNER = '0x1111111111111111111111111111111111111111'
const HASH = '0x' + 'ab'.repeat(32)
const E18 = 10n ** 18n
const NOW = Math.floor(Date.now() / 1000)
/** Oracle price: shares per 1 base unit of a 6-decimal asset — 1 USDC ≈ 0.98 shares. */
const PRICE = 980_000_000_000_000_000_000_000_000n

const vaultAbi = parseAbi([
  'function shareManager() view returns (address)', 'function feeManager() view returns (address)', 'function oracle() view returns (address)', 'function riskManager() view returns (address)',
  'function getAssetCount() view returns (uint256)', 'function assetAt(uint256) view returns (address)', 'function getQueueCount(address) view returns (uint256)', 'function queueAt(address,uint256) view returns (address)',
  'function hasQueue(address) view returns (bool)', 'function isDepositQueue(address) view returns (bool)', 'function isPausedQueue(address) view returns (bool)',
])
const smAbi = parseAbi(['function activeSharesOf(address) view returns (uint256)', 'function claimableSharesOf(address) view returns (uint256)', 'function flags() view returns (bytes)'])
const oracleAbi = parseAbi([
  'function getReport(address) view returns ((uint224 priceD18, uint32 timestamp, bool isSuspicious))',
  'function securityParams() view returns ((uint208 absoluteDeviation, uint64 relativeDeviationD18, uint64 suspiciousAbsoluteDeviation, uint64 suspiciousRelativeDeviationD18, uint32 timeout, uint32 depositInterval, uint32 redeemInterval))',
])
const feeAbi = parseAbi(['function depositFeeD6() view returns (uint24)', 'function redeemFeeD6() view returns (uint24)', 'function performanceFeeD6() view returns (uint24)', 'function protocolFeeD6() view returns (uint24)'])
const depAbi = parseAbi(['function deposit(uint224,address,bytes32[]) payable', 'function cancelDepositRequest()', 'function claimableOf(address) view returns (uint256)', 'function claim(address) returns (bool)', 'function requestOf(address) view returns (uint256,uint256)'])
const redAbi = parseAbi(['function redeem(uint256)', 'function requestsOf(address,uint256,uint256) view returns ((uint256 timestamp, uint256 shares, bool isClaimable, uint256 assets)[])', 'function claim(address,uint32[]) returns (uint256)', 'function getState() view returns (uint256,uint256,uint256,uint256)'])
const erc20Abi = parseAbi(['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'])
const sel = (abi: Abi, name: string): Hex => toFunctionSelector(getAbiItem({ abi, name }) as AbiFunction)
const enc = (abi: Abi, name: string, result: unknown): Hex => encodeFunctionResult({ abi, functionName: name, result } as never)
const decode = (abi: Abi, data: Hex): readonly unknown[] => (decodeFunctionData({ abi, data }).args ?? []) as readonly unknown[]
const encodeCall = (abi: Abi, name: string, args: readonly unknown[] = []): Hex => {
  const item = getAbiItem({ abi, name }) as AbiFunction
  return (toFunctionSelector(item) + encodeAbiParameters(item.inputs, args as never).slice(2)) as Hex
}
/** What a node answers for a call that reverts: -32000 (viem does not retry it) with the "execution reverted" message. */
const revert = (detail = ''): Error => Object.assign(new Error(`execution reverted${detail}`), { code: -32000, data: '0x' })

interface QueueSpec { q: Address; deposit: boolean; kind: 'async' | 'sync' | 'signature' }
const ASSETS: Array<{ address: Address; queues: QueueSpec[] }> = [
  { address: USDC, queues: [{ q: Q.usdcAsync, deposit: true, kind: 'async' }, { q: Q.usdcSync, deposit: true, kind: 'sync' }, { q: Q.usdcRedeem, deposit: false, kind: 'async' }, { q: Q.usdcSigRedeem, deposit: false, kind: 'signature' }] },
  { address: USDT, queues: [{ q: Q.usdtAsync, deposit: true, kind: 'async' }, { q: Q.usdtSync, deposit: true, kind: 'sync' }, { q: Q.usdtRedeem, deposit: false, kind: 'async' }] },
  { address: OTHER, queues: [{ q: Q.otherAsync, deposit: true, kind: 'async' }] },
]
const queueInfo = (address: string): QueueSpec | undefined => ASSETS.flatMap((a) => a.queues).find((x) => x.q.toLowerCase() === address.toLowerCase())

interface RedeemRequestSpec { queue: Address; timestamp: number; shares: bigint; claimable: boolean; assets: bigint }
interface StubOptions {
  shares?: bigint; claimable?: bigint; allowance?: bigint; reportAge?: number; suspicious?: boolean; syncReverts?: boolean
  paused?: string[]; pendingDeposit?: bigint; redeemRequests?: RedeemRequestSpec[]; flags?: number[]; fees?: number[]; priceD18?: bigint
}
interface CallParams { to: Address; data: Hex; from?: Address; value?: Hex }

/**
 * An EIP-1193 double of the EarnUSD deployment. Options shape the scenario:
 * report age / suspicious flag, the account's shares and queue state, the
 * allowance, whether the sync deposit proof reverts, whitelist/pause flags.
 */
function stubProvider({
  shares = 5n * E18, claimable = 0n, allowance = 0n, reportAge = 600, suspicious = false, syncReverts = false,
  paused = [], pendingDeposit = 0n, redeemRequests = [], flags = [0, 0, 0, 0], fees = [0, 0, 150000, 2000], priceD18 = PRICE,
}: StubOptions = {}) {
  const calls: Array<{ method: string; params: unknown }> = []
  const provider = {
    calls,
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      calls.push({ method, params })
      const p = params as unknown[]
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x1', blockHash: '0x' + '00'.repeat(32), transactionHash: p[0], logs: [], gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', from: OWNER, to: OWNER, contractAddress: null, index: '0x0', transactionIndex: '0x0', logsBloom: '0x' + '00'.repeat(256), type: '0x2' }
      if (method === 'eth_blockNumber') return '0x10'
      if (method !== 'eth_call') throw new Error(`stub provider: unexpected ${method}`)
      const { to, data, value } = p[0] as CallParams
      const target = getAddress(to)
      const selector = data.slice(0, 10)
      const arg = (types: string[], offset = 10): readonly unknown[] => decodeAbiParameters(types.map((type) => ({ type })), `0x${data.slice(offset)}`)
      const addr = (x: unknown): Address => getAddress(x as string)

      if (target === VAULT) {
        if (selector === sel(vaultAbi, 'shareManager')) return enc(vaultAbi, 'shareManager', SHARE_MANAGER)
        if (selector === sel(vaultAbi, 'feeManager')) return enc(vaultAbi, 'feeManager', FEE_MANAGER)
        if (selector === sel(vaultAbi, 'oracle')) return enc(vaultAbi, 'oracle', ORACLE)
        if (selector === sel(vaultAbi, 'riskManager')) return enc(vaultAbi, 'riskManager', RISK_MANAGER)
        if (selector === sel(vaultAbi, 'getAssetCount')) return enc(vaultAbi, 'getAssetCount', BigInt(ASSETS.length))
        if (selector === sel(vaultAbi, 'assetAt')) return enc(vaultAbi, 'assetAt', ASSETS[Number(arg(['uint256'])[0])]!.address)
        if (selector === sel(vaultAbi, 'getQueueCount')) return enc(vaultAbi, 'getQueueCount', BigInt(ASSETS.find((a) => a.address === addr(arg(['address'])[0]))!.queues.length))
        if (selector === sel(vaultAbi, 'queueAt')) { const [a, i] = arg(['address', 'uint256']); return enc(vaultAbi, 'queueAt', ASSETS.find((x) => x.address === addr(a))!.queues[Number(i)]!.q) }
        if (selector === sel(vaultAbi, 'hasQueue')) return enc(vaultAbi, 'hasQueue', !!queueInfo(arg(['address'])[0] as string))
        if (selector === sel(vaultAbi, 'isDepositQueue')) return enc(vaultAbi, 'isDepositQueue', !!queueInfo(arg(['address'])[0] as string)?.deposit)
        if (selector === sel(vaultAbi, 'isPausedQueue')) return enc(vaultAbi, 'isPausedQueue', paused.map((x) => x.toLowerCase()).includes((arg(['address'])[0] as string).toLowerCase()))
      }
      if (target === getAddress(SHARE_MANAGER)) {
        if (selector === sel(smAbi, 'activeSharesOf')) return enc(smAbi, 'activeSharesOf', shares)
        if (selector === sel(smAbi, 'claimableSharesOf')) return enc(smAbi, 'claimableSharesOf', claimable)
        if (selector === sel(smAbi, 'flags')) return encodeAbiParameters(Array.from({ length: 6 }, () => ({ type: 'uint256' })), [...flags, 0, 0].map((x) => BigInt(x)))
      }
      if (target === getAddress(ORACLE)) {
        if (selector === sel(oracleAbi, 'getReport')) return enc(oracleAbi, 'getReport', { priceD18, timestamp: NOW - reportAge, isSuspicious: suspicious })
        if (selector === sel(oracleAbi, 'securityParams')) return enc(oracleAbi, 'securityParams', { absoluteDeviation: 5n * 10n ** 27n, relativeDeviationD18: 10n ** 15n, suspiciousAbsoluteDeviation: 5n * 10n ** 15n, suspiciousRelativeDeviationD18: 10n ** 15n, timeout: 72000, depositInterval: 3600, redeemInterval: 172800 })
      }
      if (target === getAddress(FEE_MANAGER)) {
        const names = ['depositFeeD6', 'redeemFeeD6', 'performanceFeeD6', 'protocolFeeD6']
        for (let i = 0; i < 4; i++) if (selector === sel(feeAbi, names[i]!)) return enc(feeAbi, names[i]!, fees[i])
      }
      if (target === USDC || target === USDT) {
        if (selector === sel(erc20Abi, 'allowance')) return enc(erc20Abi, 'allowance', allowance)
      }
      const q = queueInfo(target)
      if (q) {
        if (q.deposit) {
          if (selector === sel(depAbi, 'requestOf')) {
            if (q.kind !== 'async') throw revert()
            return enc(depAbi, 'requestOf', [pendingDeposit > 0n ? BigInt(NOW - 100) : 0n, pendingDeposit])
          }
          if (selector === sel(depAbi, 'claimableOf')) return enc(depAbi, 'claimableOf', claimable)
          if (selector === sel(depAbi, 'deposit')) {
            if (q.kind === 'sync' && syncReverts) throw revert()
            return '0x'
          }
        } else {
          if (selector === sel(redAbi, 'requestsOf')) {
            if (q.kind !== 'async') throw revert()
            return enc(redAbi, 'requestsOf', redeemRequests.filter((r) => r.queue === q.q).map((r) => ({ timestamp: BigInt(r.timestamp), shares: r.shares, isClaimable: r.claimable, assets: r.assets })))
          }
          if (selector === sel(redAbi, 'redeem')) return '0x'
        }
      }
      throw revert(`: stub provider: unexpected call ${selector} to ${target} (value ${value ?? 0})`)
    },
  }
  return provider
}

type SentTx = { to: string; data: Hex; value?: bigint }
type StubAccount = MellowAccount & { sent: SentTx[]; _config?: { provider?: unknown } }

function stubAccount(provider: ReturnType<typeof stubProvider>, { readOnly = false }: { readOnly?: boolean } = {}): StubAccount {
  const sent: SentTx[] = []
  const account: StubAccount = { sent, _config: { provider }, async getAddress() { return OWNER } }
  if (!readOnly) {
    account.sendTransaction = async (tx) => { sent.push(tx as SentTx); return { hash: HASH, fee: 21_000n } }
    account.quoteSendTransaction = async () => ({ fee: 21_000n })
  }
  return account
}

const protocolFor = (opts: StubOptions = {}, { readOnly = false, config = {} }: { readOnly?: boolean; config?: Record<string, unknown> } = {}) => {
  const provider = stubProvider(opts)
  return new MellowProtocolEvm(stubAccount(provider, { readOnly }), { preset: 'lido-earn-usd', registry: null, ...config })
}
const noAccount = {} as never

describe('construction', () => {
  it('constructor: preset or vault address, unknown preset refused, reads need a provider', async () => {
    expect(new MellowProtocolEvm(noAccount, { preset: 'lido-earn-eth', provider: 'http://x' }).vault).toBe(getAddress(MELLOW_ADDRESS_MAP[1]!['lido-earn-eth']!.vault))
    expect(new MellowProtocolEvm(noAccount, { vault: VAULT.toLowerCase(), provider: 'http://x' }).vault).toBe(VAULT)
    expect(() => new MellowProtocolEvm(noAccount, { preset: 'nope' })).toThrow(/Unknown Mellow preset/)
    for (const key of Object.keys(MELLOW_ADDRESS_MAP[1]!)) expect(new MellowProtocolEvm(noAccount, { preset: key, provider: 'http://x' }).vault).toBe(getAddress(MELLOW_ADDRESS_MAP[1]![key]!.vault))
    expect(() => new MellowProtocolEvm(noAccount, {})).toThrow(/'vault' must be/)
    await expect(new MellowProtocolEvm({ async getAddress() { return OWNER } }, { vault: VAULT }).getVaultData()).rejects.toThrow(/provider/)
    expect(toAsset('native')).toBe(NATIVE_ASSET)
    expect(toAsset(zeroAddress)).toBe(NATIVE_ASSET)
    expect(toAsset(USDC.toLowerCase())).toBe(USDC)
    expect(() => toAsset('0x12')).toThrow(/'token'/)
  })
})

describe('discovery', () => {
  it('getVaultData discovers components, assets and queues on-chain and classifies each queue by its methods', async () => {
    const p = protocolFor()
    const data = await p.getVaultData()
    expect(getAddress(data.shareManager)).toBe(getAddress(SHARE_MANAGER))
    expect(getAddress(data.oracle)).toBe(getAddress(ORACLE))
    expect(data.assets.length).toBe(3)
    const usdc = data.assets.find((a) => a.address === USDC)!
    expect(usdc.depositQueues.map((q) => q.kind)).toEqual(['async', 'sync'])
    expect(usdc.redeemQueues.map((q) => q.kind)).toEqual(['async', 'signature'])
    expect(data.assets.find((a) => a.address === OTHER)!.redeemQueues.length).toBe(0)
    expect(data.fees).toEqual({ depositPct: 0, redeemPct: 0, performancePct: 15, protocolPct: 0.2 })
    expect(data.oracleParams).toEqual({ timeout: 72000, depositInterval: 3600, redeemInterval: 172800 })
    expect(data.flags).toEqual({ hasWhitelist: false, hasMintPause: false, hasBurnPause: false })
    const flagged = await protocolFor({ flags: [1, 0, 0, 1] }).getVaultData()
    expect(flagged.flags).toEqual({ hasWhitelist: true, hasMintPause: true, hasBurnPause: false })
  })
})

describe('position', () => {
  it('getPosition values shares at the report and lists queue state', async () => {
    const p = protocolFor({ shares: 5n * E18, claimable: 7n, pendingDeposit: 25_000_000n, redeemRequests: [{ queue: Q.usdcRedeem, timestamp: NOW - 5000, shares: E18, claimable: true, assets: 1_020_000n }] })
    const pos = await p.getPosition({ token: USDC })
    expect(pos.shares).toBe(5n * E18)
    expect(pos.token).toBe(USDC)
    expect(pos.value).toBe((5n * E18 * E18) / PRICE) // ≈ 5.1 USDC
    expect(pos.claimableShares).toBe(7n * 3n) // one async deposit queue per asset
    expect(pos.pendingDeposits.length).toBe(3)
    expect(pos.redeemRequests.length).toBe(1)
    expect(pos.redeemRequests[0]!.claimable).toBe(true)
  })
})

describe('supply', () => {
  it('supply USDC: approve (awaited) then deposit on the sync queue when the proof passes', async () => {
    const provider = stubProvider({ allowance: 0n })
    const account = stubAccount(provider)
    const p = new MellowProtocolEvm(account, { preset: 'lido-earn-usd', registry: null })
    const r = await p.supply({ token: USDC, amount: 10_000_000n })
    expect(r.hash).toBe(HASH)
    expect(r.instant).toBe(true)
    expect(getAddress(r.queue)).toBe(Q.usdcSync)
    expect(account.sent.length).toBe(2)
    expect(getAddress(account.sent[0]!.to)).toBe(USDC)
    expect(account.sent[0]!.data.slice(0, 10)).toBe(sel(erc20Abi, 'approve'))
    const dep = account.sent[1]!
    expect(getAddress(dep.to)).toBe(Q.usdcSync)
    expect(dep.value).toBe(0n)
    const decoded = decode(depAbi, dep.data)
    expect(decoded[0]).toBe(10_000_000n)
    expect(decoded[1]).toBe(zeroAddress)
    expect(r.fee).toBe(42_000n)
    expect(r.approveHashes).toEqual([HASH])
  })

  it('supply falls back to the async queue when the sync proof reverts; USDT allowance resets to zero first', async () => {
    const provider = stubProvider({ allowance: 5n, syncReverts: true })
    const account = stubAccount(provider)
    const p = new MellowProtocolEvm(account, { preset: 'lido-earn-usd', registry: null })
    const r = await p.supply({ token: USDT, amount: 10_000_000n })
    expect(r.instant).toBe(false)
    expect(getAddress(r.queue)).toBe(Q.usdtAsync)
    // Audit 2026-10-25 round 3, M21: the approvals went to the SYNC queue; after the fallback the
    // async queue — the one that pulls the tokens — got none, and the deposit reverted. This test
    // used to pin three sends (approve 0, approve, deposit) without looking at the spender.
    const sent = account.sent.map((t) => ({ to: getAddress(t.to), args: getAddress(t.to) === USDT ? decode(erc20Abi, t.data) : null }))
    expect(sent).toEqual([
      { to: USDT, args: [Q.usdtSync, 0n] }, { to: USDT, args: [Q.usdtSync, 10_000_000n] }, // for the sync proof
      { to: USDT, args: [Q.usdtAsync, 0n] }, { to: USDT, args: [Q.usdtAsync, 10_000_000n] }, // for the queue that takes the deposit
      { to: Q.usdtAsync, args: null },
    ])
    expect(r.approveHashes).toHaveLength(4)
    // A quote cannot prove the sync deposit while the allowance is still pending:
    // it stays optimistic on a fresh report and turns async on a stale one.
    const quote = await p.quoteSupply({ token: USDT, amount: 10_000_000n })
    expect(quote.instant).toBe(true)
    expect(quote.sharesOut).toBe((10_000_000n * PRICE) / E18)
    expect(quote.fee).toBe(63_000n)
    const stale = await protocolFor({ allowance: 5n, reportAge: 80_000 }).quoteSupply({ token: USDT, amount: 10_000_000n })
    expect(stale.instant).toBe(false)
    expect(getAddress(stale.queue)).toBe(Q.usdtAsync)
  })

  it('supply guards: unknown asset, open async request, suspicious report, whitelist, mint pause, read-only, onBehalfOf', async () => {
    await expect(protocolFor().supply({ token: OWNER, amount: 1n })).rejects.toThrow(/does not accept/)
    await expect(protocolFor({ syncReverts: true, pendingDeposit: 1n }).supply({ token: USDC, amount: 1n })).rejects.toThrow(/open deposit request/)
    await expect(protocolFor({ suspicious: true }).supply({ token: USDC, amount: 1n })).rejects.toThrow(/suspicious/)
    await expect(protocolFor({ flags: [0, 0, 0, 1] }).supply({ token: USDC, amount: 1n })).rejects.toThrow(/whitelist/)
    await expect(protocolFor({ flags: [1, 0, 0, 0] }).supply({ token: USDC, amount: 1n })).rejects.toThrow(/minting paused/)
    await expect(protocolFor({}, { readOnly: true }).supply({ token: USDC, amount: 1n })).rejects.toThrow(/non read-only/)
    await expect(protocolFor().supply({ token: USDC, amount: 1n, onBehalfOf: OWNER })).rejects.toThrow(/onBehalfOf/)
    await expect(protocolFor().supply({ token: USDC, amount: 0n })).rejects.toThrow(/greater than zero/)
    await expect(protocolFor({ paused: [Q.usdcSync, Q.usdcAsync] }).supply({ token: USDC, amount: 1n })).rejects.toThrow(/no open deposit queue/)
  })

  it('cancelSupply and claimShares target the async deposit queue', async () => {
    const provider = stubProvider({ pendingDeposit: 5n })
    const account = stubAccount(provider)
    const p = new MellowProtocolEvm(account, { preset: 'lido-earn-usd', registry: null })
    await p.cancelSupply({ token: USDC })
    expect(getAddress(account.sent[0]!.to)).toBe(Q.usdcAsync)
    expect(account.sent[0]!.data).toBe(encodeCall(depAbi, 'cancelDepositRequest', []))
    await p.claimShares({ token: USDT })
    expect(getAddress(account.sent[1]!.to)).toBe(Q.usdtAsync)
    expect(account.sent[1]!.data).toBe(encodeCall(depAbi, 'claim', [OWNER]))
    await expect(protocolFor().cancelSupply({ token: USDC })).rejects.toThrow(/No open deposit request/)
  })
})

describe('withdraw', () => {
  it('withdraw redeems shares on the async redeem queue of the payout asset and quotes the payout', async () => {
    const provider = stubProvider({ shares: 5n * E18 })
    const account = stubAccount(provider)
    const p = new MellowProtocolEvm(account, { preset: 'lido-earn-usd', registry: null })
    const r = await p.withdraw({ token: USDC, amount: 2n * E18 })
    expect(getAddress(r.queue)).toBe(Q.usdcRedeem) // not the signature queue
    expect(getAddress(account.sent[0]!.to)).toBe(Q.usdcRedeem)
    expect(decode(redAbi, account.sent[0]!.data)[0]).toBe(2n * E18)
    expect(r.assetsOut).toBe((2n * E18 * E18) / PRICE)
    const q = await p.quoteWithdraw({ token: USDT, amount: E18 })
    expect(getAddress(q.queue)).toBe(Q.usdtRedeem)
    expect(q.fee).toBe(21_000n)
  })

  it('withdraw guards: over the balance, no redeem queue for the asset, paused, burn pause, suspicious, to', async () => {
    await expect(protocolFor({ shares: E18 }).withdraw({ token: USDC, amount: 2n * E18 })).rejects.toThrow(/exceeds the account's shares/)
    await expect(protocolFor().withdraw({ token: OTHER, amount: 1n })).rejects.toThrow(/no open redeem queue/)
    await expect(protocolFor({ paused: [Q.usdcRedeem] }).withdraw({ token: USDC, amount: 1n })).rejects.toThrow(/no open redeem queue/)
    await expect(protocolFor({ flags: [0, 1, 0, 0] }).withdraw({ token: USDC, amount: 1n })).rejects.toThrow(/redemptions paused/)
    await expect(protocolFor({ suspicious: true }).withdraw({ token: USDC, amount: 1n })).rejects.toThrow(/suspicious/)
    await expect(protocolFor().withdraw({ token: USDC, amount: 1n, to: OWNER })).rejects.toThrow(/'to'/)
  })

  it('getWithdrawalRequests groups claimable requests per queue; claimWithdrawals claims them, one transaction per asset', async () => {
    const redeemRequests: RedeemRequestSpec[] = [
      { queue: Q.usdcRedeem, timestamp: NOW - 9000, shares: E18, claimable: true, assets: 1_020_000n },
      { queue: Q.usdcRedeem, timestamp: NOW - 8000, shares: E18, claimable: true, assets: 1_030_000n },
      { queue: Q.usdcRedeem, timestamp: NOW - 100, shares: E18, claimable: false, assets: 0n },
      { queue: Q.usdtRedeem, timestamp: NOW - 7000, shares: E18 / 2n, claimable: true, assets: 500_000n },
    ]
    const provider = stubProvider({ redeemRequests })
    const account = stubAccount(provider)
    const p = new MellowProtocolEvm(account, { preset: 'lido-earn-usd', registry: null })
    const view = await p.getWithdrawalRequests()
    expect(view.requests.length).toBe(4)
    expect(view.requests[0]!.timestamp).toBe(NOW - 100) // newest first
    expect(view.pendingShares).toBe(E18)
    expect(view.claimable.length).toBe(2)
    const usdc = view.claimable.find((c) => c.token === USDC)!
    expect(usdc.assets).toBe(2_050_000n)
    expect(usdc.timestamps).toEqual([NOW - 8000, NOW - 9000])

    const all = await p.claimWithdrawals()
    expect(all.hashes.length).toBe(2)
    expect(account.sent.length).toBe(2)
    const usdcClaim = account.sent.find((t) => getAddress(t.to) === Q.usdcRedeem)!
    const [receiver, ts] = decode(redAbi, usdcClaim.data) as [string, readonly number[]]
    expect(receiver).toBe(OWNER)
    expect(ts.map(Number)).toEqual([NOW - 8000, NOW - 9000])
    expect(all.assets.map((a) => a.amount).sort((a, b) => (a < b ? -1 : 1))).toEqual([500_000n, 2_050_000n])

    const one = await p.claimWithdrawals({ token: USDC, timestamps: [NOW - 9000] })
    expect(one.hashes.length).toBe(1)
    expect((decode(redAbi, account.sent[2]!.data)[1] as readonly number[]).map(Number)).toEqual([NOW - 9000])
    await expect(protocolFor().claimWithdrawals()).rejects.toThrow(/Nothing is claimable/)
  })

  it('claimWithdrawals claims only on pinned redeem queues, as every other queue call (scan 2026-10-27 modules, F25/F26)', async () => {
    const redeemRequests: RedeemRequestSpec[] = [{ queue: Q.usdcRedeem, timestamp: NOW - 9000, shares: E18, claimable: true, assets: 1_020_000n }]
    // The RPC lists Q.usdcRedeem; the app pinned another redeem queue for this vault.
    const pinnedElsewhere = stubAccount(stubProvider({ redeemRequests }))
    const p = new MellowProtocolEvm(pinnedElsewhere, { vault: VAULT, registry: null, queues: { deposit: [Q.usdcAsync], redeem: [Q.usdtRedeem] } })
    await expect(p.claimWithdrawals()).rejects.toThrow(/is not a redeem queue pinned for vault/)
    expect(pinnedElsewhere.sent).toHaveLength(0)
    // A vault without pinned queues claims nothing either.
    const unpinned = stubAccount(stubProvider({ redeemRequests }))
    await expect(new MellowProtocolEvm(unpinned, { vault: VAULT, registry: null }).claimWithdrawals()).rejects.toThrow(/no pinned redeem queues: pass config.queues/)
    expect(unpinned.sent).toHaveLength(0)
  })
})

describe('not lending', () => {
  it('borrow and repay reject with NotImplementedError', async () => {
    const p = protocolFor()
    for (const m of ['borrow', 'quoteBorrow', 'repay', 'quoteRepay'] as const) {
      await expect(p[m]({ token: USDC, amount: 1n })).rejects.toSatisfy((e: unknown) => (e as Error).name === 'NotImplementedError' && /do not lend/.test((e as Error).message))
    }
  })
})

describe('registry', () => {
  it('getStats / getApr read the registry by vault address; null / rejection without it', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: true, json: async () => [{ id: 'lido-earn-usd', name: 'Lido EarnUSD', address: VAULT.toLowerCase(), apy: 7.78, tvl_usd: 30_600_000, withdraw_avg_time_seconds: 40_000 }] })) as unknown as typeof fetch
    try {
      const p = protocolFor({}, { config: { registry: 'https://example.invalid/vaults' } })
      expect(await p.getStats()).toEqual({ id: 'lido-earn-usd', name: 'Lido EarnUSD', apy: 7.78, tvlUsd: 30_600_000, withdrawAvgSeconds: 40_000 })
      expect(await p.getApr()).toBe(7.78)
    } finally {
      globalThis.fetch = orig
    }
    expect(await protocolFor().getStats()).toBe(null)
    await expect(protocolFor().getApr()).rejects.toThrow(/registry/)
  })
})
