import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes, keccak256, parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { externalSigner } from '@anywalletkit/core'
import { BroadcastUnknownError, NonceConflictError, WalletManagerEvm } from '../src/index.js'

// Scan 2026-10-30 F1: a malicious RPC keeps the first signed bytes, answers "nonce too low" and
// denies the hash (eth_getTransactionByHash → null). The account re-signed the same payload with
// nonce n+1, and the RPC held two valid, independent transactions for one send. Now one RPC's word
// is not proof: the send ends as NonceConflictError (maybe sent, the first hash) with one signature.

const HARDHAT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const KEY = hexToBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const TO = '0x000000000000000000000000000000000000bEEF'
const BLOCK = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }

function maliciousRpc() {
  const withheld: Hex[] = []
  let first = true
  const handlers: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x1', eth_blockNumber: () => '0x10', eth_getBlockByNumber: () => BLOCK,
    eth_maxPriorityFeePerGas: () => '0x3b9aca00', eth_gasPrice: () => '0x6fc23ac00', eth_estimateGas: () => '0x5208',
    eth_getBalance: () => '0xde0b6b3a7640000', eth_getTransactionCount: (p) => (p[1] === 'latest' ? '0x8' : '0x7') /* lie: nonce 7 is mined */, eth_call: () => '0x',
    eth_getTransactionByHash: () => null, // lie: "never seen it"
    eth_sendRawTransaction: (p) => {
      withheld.push(p[0] as Hex) // keep every signed tx to broadcast later
      if (first) { first = false; throw Object.assign(new Error('nonce too low: next nonce 8, tx nonce 7'), { code: -32000 }) }
      return keccak256(p[0] as Hex)
    },
  }
  const provider = { request: async ({ method, params }: { method: string; params?: unknown }) => {
    const h = handlers[method]; if (!h) throw new Error(`unmocked ${method}`); return h((params as unknown[]) ?? [])
  } } as unknown as EIP1193Provider
  return { provider, withheld }
}

describe('scan 2026-10-30 F1: nonce-too-low + negative lookup from an untrusted RPC', () => {
  it('signs exactly one transaction and reports it maybe sent', async () => {
    const { provider, withheld } = maliciousRpc()
    let sigs = 0
    const signer = externalSigner({
      curve: 'secp256k1', publicKey: secp256k1.getPublicKey(KEY),
      sign: async (payload, o) => {
        if (o.context === 'evm-tx') sigs++
        const r = secp256k1.sign(payload, KEY, { prehash: false, format: 'recovered' })
        const out = new Uint8Array(65); out.set(r.subarray(1)); out[64] = r[0]!; return out
      },
    })
    const a = await new WalletManagerEvm(signer, { provider }).getAccount()
    expect((await a.getAddress()).toLowerCase()).toBe(HARDHAT0.toLowerCase())
    const res = await a.sendTransaction({ to: TO, value: 1n }).catch((e: unknown) => e)
    expect(sigs).toBe(1)
    expect(withheld).toHaveLength(1)
    expect(res).toBeInstanceOf(BroadcastUnknownError)
    expect(res).toBeInstanceOf(NonceConflictError)
    expect(res).toMatchObject({ maybeSent: true, hash: keccak256(withheld[0]!), nonce: 7, nextNonce: 8 })
    expect(parseTransaction(withheld[0]!).nonce).toBe(7)
  })
})
