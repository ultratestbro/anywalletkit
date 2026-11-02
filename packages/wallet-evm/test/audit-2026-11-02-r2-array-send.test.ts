import { describe, expect, it, vi } from 'vitest'
import { parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { applyPolicies } from '@anywalletkit/kit'
import { UnsafeTransactionError, WalletManagerEvm } from '../src/index.js'

// A list with named fields on the network paths: a caller-set gasLimit and `simulate: false` skip
// every step that used to look at the raw input, so the shape must be checked before anything else.
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ALLOWED = '0x00000000000000000000000000000000000a110e'
const OTHER = '0x00000000000000000000000000000000000e0e01'

function provider() {
  const sent: Hex[] = []
  const calls: string[] = []
  const h: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x1', eth_blockNumber: () => '0x10',
    eth_getBlockByNumber: () => ({ number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }),
    eth_maxPriorityFeePerGas: () => '0x3b9aca00', eth_gasPrice: () => '0x6fc23ac00', eth_estimateGas: () => '0x5208',
    eth_getTransactionCount: () => '0x7', eth_getBalance: () => '0xde0b6b3a7640000', eth_call: () => '0x',
    eth_feeHistory: () => ({ oldestBlock: '0x10', baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0.5], reward: [['0x3b9aca00']] }),
    eth_sendRawTransaction: (p) => { sent.push(p[0] as Hex); return '0x' + 'ab'.repeat(32) },
  }
  const p = { request: async ({ method, params }: { method: string; params?: unknown[] }) => { calls.push(method); const f = h[method]; if (!f) throw Object.assign(new Error('no ' + method), { code: -32601 }); return f(params ?? []) } }
  return { sent, calls, p: p as unknown as EIP1193Provider }
}

const shaped = () => Object.assign([{ to: ALLOWED, value: 0n }], { to: OTHER, value: 10n ** 15n, gasLimit: 21_000n })

describe('sendTransaction / quotes refuse a list with named fields before reading it', () => {
  it('raw account, simulate: false, gasLimit set: refused, nothing broadcast', async () => {
    const { sent, p } = provider()
    const acc = await new WalletManagerEvm(SEED, { provider: p, simulate: false }).getAccount()
    await expect(acc.sendTransaction(shaped() as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    expect(sent).toHaveLength(0)
    // control: the same named fields as a plain object are sent
    await expect(acc.sendTransaction({ to: OTHER, value: 10n ** 15n, gasLimit: 21_000n })).resolves.toMatchObject({ hash: '0x' + 'ab'.repeat(32) })
    expect(sent).toHaveLength(1)
    expect(parseTransaction(sent[0]!).to?.toLowerCase()).toBe(OTHER)
  })

  it('kit with a confirm-only policy: the hook may approve, the wallet still refuses the list', async () => {
    const { sent, p } = provider()
    const acc = await new WalletManagerEvm(SEED, { provider: p, simulate: false }).getAccount()
    const confirm = vi.fn(async () => true)
    const g = applyPolicies(acc, { confirm }, 'eip155:1')
    await expect(g.sendTransaction(shaped() as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    expect(sent).toHaveLength(0)
  })

  it('a refused list touches no RPC on the send path; transfer is unaffected', async () => {
    const { sent, calls, p } = provider()
    const acc = await new WalletManagerEvm(SEED, { provider: p, simulate: false }).getAccount()
    calls.length = 0
    await expect(acc.sendTransaction(shaped() as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    expect(calls).toEqual([])
    await expect(acc.transfer({ token: '0x' + '00'.repeat(19) + '01', recipient: OTHER, amount: 1n })).resolves.toMatchObject({ hash: expect.any(String) })
    expect(sent).toHaveLength(1)
  })

  it('quoteSendTransaction with a gasLimit refuses the list; the plain object is quoted', async () => {
    const { p } = provider()
    const acc = await new WalletManagerEvm(SEED, { provider: p }).getAccount()
    await expect(acc.quoteSendTransaction(shaped() as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    await expect(acc.quoteSendTransaction({ to: OTHER, value: 1n, gasLimit: 21_000n })).resolves.toMatchObject({ fee: expect.any(BigInt) })
  })

  it('signTransaction and simulateTransaction refuse it too (control for the offline and dry-run paths)', async () => {
    const { p } = provider()
    const acc = await new WalletManagerEvm(SEED, { provider: p }).getAccount()
    await expect(acc.signTransaction(shaped() as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    await expect(acc.simulateTransaction(shaped() as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
  })
})
