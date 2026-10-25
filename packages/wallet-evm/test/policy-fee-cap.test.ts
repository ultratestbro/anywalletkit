import { describe, expect, it } from 'vitest'
import { parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { PolicyViolationError, applyPolicies } from '@anywalletkit/kit'
import { WalletManagerEvm } from '../src/index.js'

// Audit 2026-10-25, #4 (rest): `policies.maxFee` was checked on quoteSendTransaction (21 000 gas)
// while the account signed 25 200 gas (×1.2 headroom). The kit cap must hold for what is signed.
const QUOTE = 21_000n * 2_200_000_000n // 4.62e13 wei
const SIGNED = 25_200n * 2_200_000_000n // 5.544e13 wei
const BETWEEN = 50_000_000_000_000n
const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'

function fakeProvider() {
  const sent: Hex[] = []
  const block = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
  const handlers: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x1',
    eth_blockNumber: () => '0x10',
    eth_getBlockByNumber: () => block,
    eth_maxPriorityFeePerGas: () => '0x3b9aca00', // tip 1 gwei, base 1 gwei: maxFeePerGas = 1.2 × base + tip = 2.2 gwei
    eth_gasPrice: () => '0x83215600', // 2.2 gwei
    eth_estimateGas: () => '0x5208', // 21 000
    eth_getBalance: () => '0xde0b6b3a7640000',
    eth_getTransactionCount: () => '0x7',
    eth_call: () => '0x',
    eth_sendRawTransaction: (p) => { sent.push(p[0] as Hex); return '0x' + 'ab'.repeat(32) },
  }
  const provider = { request: async ({ method, params }: { method: string; params?: unknown }) => handlers[method]!((params as unknown[]) ?? []) } as unknown as EIP1193Provider
  return { provider, sent }
}

describe('kit maxFee holds for the transaction the EVM account signs', () => {
  it('the quote fits the cap but the signed fee would not: refused, nothing sent', async () => {
    const { provider, sent } = fakeProvider()
    const account = await new WalletManagerEvm(SEED, { provider, chainId: 1 }).getAccount(0)
    expect((await account.quoteSendTransaction({ to: TO, value: 1n })).fee).toBe(QUOTE)
    const guarded = applyPolicies(account, { maxFee: { 'eip155:1': BETWEEN } }, 'eip155:1')
    await expect(guarded.sendTransaction({ to: TO, value: 1n })).rejects.toThrow(/maximum fee/)
    await expect(guarded.transfer({ recipient: TO, amount: 1n })).rejects.toThrow(/maximum fee/)
    expect(sent).toHaveLength(0)
  })

  it('a cap that covers the signed fields lets the send through; the signed fee is within it', async () => {
    const { provider, sent } = fakeProvider()
    const account = await new WalletManagerEvm(SEED, { provider, chainId: 1 }).getAccount(0)
    const res = await applyPolicies(account, { maxFee: { eip155: SIGNED } }, 'eip155:1').sendTransaction({ to: TO, value: 1n })
    const tx = parseTransaction(sent[0]!)
    expect(tx.gas! * tx.maxFeePerGas!).toBe(SIGNED)
    expect(res.fee).toBe(SIGNED)
  })

  it('approve is held to the cap too — directly and through the kit (audit 2026-10-25 post-release, L2)', async () => {
    const TOKEN = '0x000000000000000000000000000000000000Cafe'
    const { provider, sent } = fakeProvider()
    const account = await new WalletManagerEvm(SEED, { provider, chainId: 1 }).getAccount(0)
    const approval = { token: TOKEN, spender: TO, amount: 5n }
    await expect(account.approve(approval, { maxFee: BETWEEN })).rejects.toThrow(/maximum fee/)
    await expect(applyPolicies(account, { maxFee: { 'eip155:1': BETWEEN } }, 'eip155:1').approve(approval)).rejects.toThrow(/maximum fee/)
    expect(sent).toHaveLength(0)
    await expect(applyPolicies(account, { maxFee: { eip155: SIGNED } }, 'eip155:1').approve(approval)).resolves.toMatchObject({ fee: SIGNED })
    expect(sent).toHaveLength(1)
  })

  it('the tighter of the account config and the policy wins', async () => {
    const { provider } = fakeProvider()
    const account = await new WalletManagerEvm(SEED, { provider, chainId: 1, transactionMaxFee: SIGNED }).getAccount(0)
    await expect(applyPolicies(account, { maxFee: { 'eip155:1': BETWEEN } }, 'eip155:1').sendTransaction({ to: TO, value: 1n })).rejects.toThrow(/maximum fee/)
    await expect(account.sendTransaction({ to: TO, value: 1n }, { maxFee: BETWEEN })).rejects.toThrow(/maximum fee/)
    // the quote check still refuses early, as a PolicyViolationError, when even the quote is over
    await expect(applyPolicies(account, { maxFee: { 'eip155:1': 1n } }, 'eip155:1').sendTransaction({ to: TO, value: 1n })).rejects.toBeInstanceOf(PolicyViolationError)
  })
})
