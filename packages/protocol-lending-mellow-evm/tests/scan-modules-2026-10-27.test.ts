// Scan 2026-10-27 (modules), F25/F26: the deposit queue — the ERC-20 spender and the native deposit's recipient — came
// from `vault.queueAt` on the RPC, and `hasQueue` asked the same RPC. A user-added or tampered RPC named its own queue
// and the module approved and paid it, even for the shipped presets. Now a queue must be in the preset's shipped list
// (or the caller's `queues`). An EIP-1193 double here: the vault answers with an attacker queue, everything else honest.
import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionResult, getAbiItem, getAddress, parseAbi, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from 'viem'
import MellowProtocolEvm, { MELLOW_ADDRESS_MAP, NATIVE_ASSET, type MellowAccount } from '../src/index.js'

const OWNER = '0x1111111111111111111111111111111111111111'
const ATTACKER_QUEUE = getAddress('0x9999999999999999999999999999999999999999')
const USDC = getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
const SHARE_MANAGER = getAddress('0x00000000000000000000000000000000000000aa')
const FEE_MANAGER = getAddress('0x00000000000000000000000000000000000000fe')
const ORACLE = getAddress('0x00000000000000000000000000000000000000cc')
const RISK_MANAGER = getAddress('0x00000000000000000000000000000000000000f1')
const NOW = Math.floor(Date.now() / 1000)
const E18 = 10n ** 18n

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
const depAbi = parseAbi(['function requestOf(address) view returns (uint256,uint256)', 'function claimableOf(address) view returns (uint256)'])
const erc20Abi = parseAbi(['function allowance(address,address) view returns (uint256)'])
const sel = (abi: Abi, name: string): Hex => toFunctionSelector(getAbiItem({ abi, name }) as AbiFunction)
const enc = (abi: Abi, name: string, result: unknown): Hex => encodeFunctionResult({ abi, functionName: name, result } as never)

/** The preset's vault with one asset whose only deposit queue is `queue` (async), and the RPC vouching for it. */
function rpc(vault: Address, asset: Address, queue: Address) {
  const calls: string[] = []
  return {
    calls,
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_blockNumber') return '0x10'
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x1', blockHash: '0x' + '00'.repeat(32), transactionHash: (params as unknown[])[0], logs: [], gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', from: OWNER, to: OWNER, contractAddress: null, index: '0x0', transactionIndex: '0x0', logsBloom: '0x' + '00'.repeat(256), type: '0x2' }
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
      const { to, data } = (params as Array<{ to: Address; data: Hex }>)[0]!
      const target = getAddress(to), selector = data.slice(0, 10)
      const arg = (types: string[]) => decodeAbiParameters(types.map((type) => ({ type })), `0x${data.slice(10)}`)
      calls.push(`${target}:${selector}`)
      if (target === vault) {
        if (selector === sel(vaultAbi, 'shareManager')) return enc(vaultAbi, 'shareManager', SHARE_MANAGER)
        if (selector === sel(vaultAbi, 'feeManager')) return enc(vaultAbi, 'feeManager', FEE_MANAGER)
        if (selector === sel(vaultAbi, 'oracle')) return enc(vaultAbi, 'oracle', ORACLE)
        if (selector === sel(vaultAbi, 'riskManager')) return enc(vaultAbi, 'riskManager', RISK_MANAGER)
        if (selector === sel(vaultAbi, 'getAssetCount')) return enc(vaultAbi, 'getAssetCount', 1n)
        if (selector === sel(vaultAbi, 'assetAt')) return enc(vaultAbi, 'assetAt', asset)
        if (selector === sel(vaultAbi, 'getQueueCount')) return enc(vaultAbi, 'getQueueCount', 1n)
        if (selector === sel(vaultAbi, 'queueAt')) return enc(vaultAbi, 'queueAt', queue)
        // The lying RPC vouches for its own queue.
        if (selector === sel(vaultAbi, 'hasQueue')) return enc(vaultAbi, 'hasQueue', getAddress(arg(['address'])[0] as string) === queue)
        if (selector === sel(vaultAbi, 'isDepositQueue')) return enc(vaultAbi, 'isDepositQueue', true)
        if (selector === sel(vaultAbi, 'isPausedQueue')) return enc(vaultAbi, 'isPausedQueue', false)
      }
      if (target === SHARE_MANAGER) {
        if (selector === sel(smAbi, 'flags')) return encodeAbiParameters(Array.from({ length: 6 }, () => ({ type: 'uint256' })), [0n, 0n, 0n, 0n, 0n, 0n])
        if (selector === sel(smAbi, 'activeSharesOf') || selector === sel(smAbi, 'claimableSharesOf')) return enc(smAbi, 'activeSharesOf', 0n)
      }
      if (target === ORACLE) {
        if (selector === sel(oracleAbi, 'getReport')) return enc(oracleAbi, 'getReport', { priceD18: E18, timestamp: NOW - 60, isSuspicious: false })
        if (selector === sel(oracleAbi, 'securityParams')) return enc(oracleAbi, 'securityParams', { absoluteDeviation: 1n, relativeDeviationD18: 1n, suspiciousAbsoluteDeviation: 1n, suspiciousRelativeDeviationD18: 1n, timeout: 72000, depositInterval: 3600, redeemInterval: 172800 })
      }
      if (target === FEE_MANAGER) for (const n of ['depositFeeD6', 'redeemFeeD6', 'performanceFeeD6', 'protocolFeeD6']) if (selector === sel(feeAbi, n)) return enc(feeAbi, n, 0)
      if (target === USDC && selector === sel(erc20Abi, 'allowance')) return enc(erc20Abi, 'allowance', 0n)
      if (target === queue) {
        if (selector === sel(depAbi, 'requestOf')) return enc(depAbi, 'requestOf', [0n, 0n]) // answers → classified async
        if (selector === sel(depAbi, 'claimableOf')) return enc(depAbi, 'claimableOf', 0n)
      }
      throw Object.assign(new Error('execution reverted'), { code: -32000, data: '0x' })
    },
  }
}

function account(provider: ReturnType<typeof rpc>): MellowAccount & { sent: unknown[] } {
  const sent: unknown[] = []
  return { sent, _config: { provider }, async getAddress() { return OWNER }, async sendTransaction(tx: unknown) { sent.push(tx); return { hash: '0x' + 'ab'.repeat(32), fee: 21_000n } }, async quoteSendTransaction() { return { fee: 21_000n } } } as never
}

describe('Mellow: a deposit queue must be one the package or the caller pinned (scan 2026-10-27 modules, F25/F26)', () => {
  it("lido-earn-eth: an RPC naming its own queue (hasQueue = true) gets no native ETH — refused before anything is sent", async () => {
    const vault = getAddress(MELLOW_ADDRESS_MAP[1]!['lido-earn-eth']!.vault)
    const acc = account(rpc(vault, NATIVE_ASSET as Address, ATTACKER_QUEUE))
    const p = new MellowProtocolEvm(acc, { preset: 'lido-earn-eth', registry: null })
    await expect(p.supply({ token: 'native', amount: E18 })).rejects.toThrow(/Queue 0x9999.* is not a deposit queue pinned for vault/)
    await expect(p.quoteSupply({ token: 'native', amount: E18 })).rejects.toThrow(/not a deposit queue pinned/)
    expect(acc.sent).toHaveLength(0)
  })

  it('lido-earn-usd: the same for USDC — no allowance to the attacker queue', async () => {
    const vault = getAddress(MELLOW_ADDRESS_MAP[1]!['lido-earn-usd']!.vault)
    const acc = account(rpc(vault, USDC, ATTACKER_QUEUE))
    const p = new MellowProtocolEvm(acc, { preset: 'lido-earn-usd', registry: null })
    await expect(p.supply({ token: USDC, amount: 1_000_000n })).rejects.toThrow(/not a deposit queue pinned/)
    expect(acc.sent).toHaveLength(0)
  })

  it("a shipped queue still works; a custom vault needs config.queues, which also admits a queue Mellow added after a release", async () => {
    const vault = getAddress(MELLOW_ADDRESS_MAP[1]!['lido-earn-usd']!.vault)
    const shipped = getAddress(MELLOW_ADDRESS_MAP[1]!['lido-earn-usd']!.queues!.deposit[0]!)
    const ok = account(rpc(vault, USDC, shipped))
    await new MellowProtocolEvm(ok, { preset: 'lido-earn-usd', registry: null }).supply({ token: USDC, amount: 1_000_000n })
    expect(ok.sent.length).toBeGreaterThan(0)
    const custom = account(rpc(vault, USDC, ATTACKER_QUEUE))
    await expect(new MellowProtocolEvm(custom, { vault, registry: null }).supply({ token: USDC, amount: 1_000_000n })).rejects.toThrow(/no pinned deposit queues: pass config.queues/)
    const pinned = account(rpc(vault, USDC, ATTACKER_QUEUE))
    await new MellowProtocolEvm(pinned, { vault, registry: null, queues: { deposit: [ATTACKER_QUEUE] } }).supply({ token: USDC, amount: 1_000_000n })
    expect(pinned.sent.length).toBeGreaterThan(0)
    expect(() => new MellowProtocolEvm(custom, { vault, registry: null, queues: { deposit: ['nope'] } })).toThrow(/is not an address/)
  })
})
