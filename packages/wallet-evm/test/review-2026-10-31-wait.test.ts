import { describe, expect, it } from 'vitest'
import type { EIP1193Provider } from 'viem'
import { TransactionRevertedError, WalletManagerEvm } from '../src/index.js'

// swap2's engine calls signer.waitForTransaction(hash) between an approval and the deposit that
// spends it. wallet-evm now has it: resolve once mined, throw on a revert or after the timeout.

const SEED = 'test test test test test test test test test test test junk'
const HASH = '0x' + 'ab'.repeat(32)
const receipt = (status: '0x1' | '0x0') => ({
  transactionHash: HASH, transactionIndex: '0x0', blockHash: '0x' + '11'.repeat(32), blockNumber: '0x10', from: '0x' + '00'.repeat(20), to: '0x' + '00'.repeat(20),
  cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256), status, type: '0x2',
})

function node(answer: () => unknown) {
  return {
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_blockNumber') return '0x10'
      if (method === 'eth_getTransactionReceipt') return answer()
      if (method === 'eth_getTransactionByHash') return null
      throw new Error(`unmocked ${method}`)
    },
  } as unknown as EIP1193Provider
}

const account = async (answer: () => unknown) => new WalletManagerEvm(SEED, { provider: node(answer) }).getAccount(0)

describe('wallet-evm waitForTransaction', () => {
  it('resolves once the transaction is mined successfully', async () => {
    await expect((await account(() => receipt('0x1'))).waitForTransaction(HASH)).resolves.toBeUndefined()
  })

  it('throws when the transaction reverted', async () => {
    const e = await (await account(() => receipt('0x0'))).waitForTransaction(HASH).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TransactionRevertedError)
    expect(e).toMatchObject({ code: 'reverted', hash: HASH, blockNumber: 16n })
  })

  it('throws after the timeout when no receipt comes', async () => {
    const e = await (await account(() => null)).waitForTransaction(HASH, 50).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(Error)
    expect((e as { code?: unknown }).code).not.toBe('reverted')
  })

  it('an RPC failure does not carry the reverted code', async () => {
    const e = await (await account(() => { throw Object.assign(new Error('internal error'), { code: -32603 }) })).waitForTransaction(HASH, 200).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(Error)
    expect((e as { code?: unknown }).code).not.toBe('reverted')
  })

  it('refuses something that is not a transaction hash', async () => {
    await expect((await account(() => receipt('0x1'))).waitForTransaction('0x1234')).rejects.toThrow(/Not a transaction hash/)
  })
})
