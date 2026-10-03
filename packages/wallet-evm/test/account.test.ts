import { describe, expect, it } from 'vitest'
import { decodeFunctionData, parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { ERC20_ABI, WalletManagerEvm } from '../src/index.js'

const SEED = 'test test test test test test test test test test test junk'
const HARDHAT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const SPENDER = '0x000000000000000000000000000000000000bEEF'

/** A fake EIP-1193 provider: answers the JSON-RPC the account needs and records what it broadcast. */
function fakeProvider(overrides: Record<string, (params: unknown[]) => unknown> = {}) {
  const sent: Hex[] = []
  const calls: string[] = []
  const handlers: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => '0x1',
    eth_blockNumber: () => '0x10',
    eth_getBlockByNumber: () => ({ number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }),
    eth_maxPriorityFeePerGas: () => '0x3b9aca00',
    eth_gasPrice: () => '0x6fc23ac00',
    eth_estimateGas: () => '0x5208',
    eth_getTransactionCount: () => '0x7',
    eth_getBalance: () => '0xde0b6b3a7640000',
    eth_call: () => '0x' + '0'.repeat(63) + '0', // allowance / balanceOf = 0
    eth_sendRawTransaction: (p) => { sent.push(p[0] as Hex); return '0x' + 'ab'.repeat(32) },
    ...overrides,
  }
  return {
    sent, calls,
    provider: { request: async ({ method, params }: { method: string; params?: unknown }) => { calls.push(method); const h = handlers[method]; if (!h) throw new Error(`unmocked ${method}`); return h((params as unknown[]) ?? []) } } as unknown as EIP1193Provider,
  }
}

describe('WalletAccountEvm', () => {
  it('derives the Hardhat default account and caches by path', async () => {
    const m = new WalletManagerEvm(SEED)
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(HARDHAT0)
    expect(a.index).toBe(0)
    expect(a.chain).toBe('eip155:unknown')
    expect(await m.getAccountByPath("m/44'/60'/0'/0/0")).toBe(a)
    m.dispose()
  })

  it('sign + verify round-trips; v is 27/28', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const a = await m.getAccount(0)
    const sig = await a.sign('hello')
    expect(sig).toHaveLength(132)
    expect(['1b', '1c']).toContain(sig.slice(-2))
    expect(await a.verify('hello', sig)).toBe(true)
    expect(await a.verify('hello!', sig)).toBe(false)
    m.dispose()
  })

  it('offline signTransaction needs chainId from the tx or the config', async () => {
    const m = new WalletManagerEvm(SEED)
    const a = await m.getAccount(0)
    await expect(a.signTransaction({ to: SPENDER, value: 1n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).rejects.toThrow(/provider/)
    const m2 = new WalletManagerEvm(SEED, { chainId: 10 })
    const raw = await (await m2.getAccount(0)).signTransaction({ to: SPENDER, value: 1n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
    expect(parseTransaction(raw as Hex).chainId).toBe(10)
    m.dispose(); m2.dispose()
  })

  it('transfer(ERC-20) encodes transfer(to, amount) and broadcasts a signed tx with fee = gas × feeRate', async () => {
    const fake = fakeProvider()
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    const a = await m.getAccount(0)
    const res = await a.transfer({ token: USDT, recipient: SPENDER, amount: 1_000_000n })
    expect(res.hash).toBe('0x' + 'ab'.repeat(32))
    expect(res.fee).toBe(21000n * 2_200_000_000n) // gas × maxFeePerGas, where viem estimates maxFee = baseFee × 1.2 + tip = 1.2e9 + 1e9
    const tx = parseTransaction(fake.sent[0]!)
    expect(tx.to?.toLowerCase()).toBe(USDT.toLowerCase())
    expect(tx.chainId).toBe(1)
    expect(tx.nonce).toBe(7)
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: tx.data! })
    expect(decoded.functionName).toBe('transfer')
    expect(decoded.args).toEqual([SPENDER, 1_000_000n])
    m.dispose()
  })

  it('transfer(native) sets value and empty data', async () => {
    const fake = fakeProvider()
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    await (await m.getAccount(0)).transfer({ recipient: SPENDER, amount: 5n })
    const tx = parseTransaction(fake.sent[0]!)
    expect(tx.value).toBe(5n)
    expect(tx.data ?? '0x').toBe('0x')
    m.dispose()
  })

  it('transferMaxFee is enforced before anything is sent', async () => {
    const fake = fakeProvider()
    const m = new WalletManagerEvm(SEED, { provider: fake.provider, transferMaxFee: 1n })
    await expect((await m.getAccount(0)).transfer({ recipient: SPENDER, amount: 5n })).rejects.toThrow(/maximum fee/)
    expect(fake.sent).toHaveLength(0)
    m.dispose()
  })

  it('approve on mainnet USDT refuses non-zero → non-zero unless autoResetAllowance', async () => {
    const nonZero = { eth_call: () => '0x' + '0'.repeat(63) + '5' }
    const fake = fakeProvider(nonZero)
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    await expect((await m.getAccount(0)).approve({ token: USDT, spender: SPENDER, amount: 10n })).rejects.toThrow(/reset to 0/)
    expect(fake.sent).toHaveLength(0)

    const fake2 = fakeProvider({ ...nonZero, eth_getTransactionReceipt: () => ({ transactionHash: '0x' + 'ab'.repeat(32), status: '0x1', blockNumber: '0x11', gasUsed: '0x5208', effectiveGasPrice: '0x1', from: HARDHAT0, to: USDT, contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256), blockHash: '0x' + '11'.repeat(32), transactionIndex: '0x0', cumulativeGasUsed: '0x5208', type: '0x2' }) })
    const m2 = new WalletManagerEvm(SEED, { provider: fake2.provider, autoResetAllowance: true })
    await (await m2.getAccount(0)).approve({ token: USDT, spender: SPENDER, amount: 10n })
    expect(fake2.sent).toHaveLength(2)
    const amounts = fake2.sent.map((raw) => decodeFunctionData({ abi: ERC20_ABI, data: parseTransaction(raw).data! }).args![1])
    expect(amounts).toEqual([0n, 10n])
    m.dispose(); m2.dispose()
  })

  it('read-only account has no signing methods; dispose kills signing', async () => {
    const m = new WalletManagerEvm(SEED)
    const a = await m.getAccount(0)
    const ro = a.toReadOnlyAccount()
    const bag = ro as unknown as Record<string, unknown>
    expect(bag.sign).toBeUndefined()
    expect(bag.sendTransaction).toBeUndefined()
    expect(await ro.getAddress()).toBe(HARDHAT0)
    m.dispose()
    await expect(a.sign('x')).rejects.toThrow(/disposed/)
  })

  it('getTransactionReceipt maps status to 1/0 and returns undefined when not found', async () => {
    const fake = fakeProvider({ eth_getTransactionReceipt: () => null })
    const m = new WalletManagerEvm(SEED, { provider: fake.provider })
    expect(await (await m.getAccount(0)).getTransactionReceipt('0x' + 'ab'.repeat(32))).toBeUndefined()
    m.dispose()
  })
})
