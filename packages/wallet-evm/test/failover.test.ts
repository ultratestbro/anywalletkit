import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes, keccak256, parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { externalSigner } from '@anywalletkit/core'
import { BroadcastUnknownError, WalletManagerEvm } from '../src/index.js'

// Audit 2026-10-25, finding 1: a lost broadcast answer followed by "already known" /
// "nonce too low" from the next RPC must never produce a second signed transaction.

const HARDHAT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const HARDHAT0_KEY = hexToBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const SPENDER = '0x000000000000000000000000000000000000bEEF'
const BLOCK = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }

/** A signer that counts its signatures: the number that matters for a double spend. */
function countingSigner() {
  const signed: string[] = []
  const signer = externalSigner({
    curve: 'secp256k1',
    publicKey: secp256k1.getPublicKey(HARDHAT0_KEY),
    sign: async (payload, o) => {
      signed.push(o.context ?? '')
      const r = secp256k1.sign(payload, HARDHAT0_KEY, { prehash: false, format: 'recovered' })
      const out = new Uint8Array(65); out.set(r.subarray(1)); out[64] = r[0]!
      return out
    },
  })
  return { signer, txSignatures: () => signed.filter((c) => c === 'evm-tx').length }
}

/** The network every RPC in a test shares: the mempool, mined txs (by hash) and the nonces they used. */
interface Net { pool: Map<Hex, Hex>; chain: Map<Hex, Hex>; used: Set<number> }
const network = (used: number[] = []): Net => ({ pool: new Map(), chain: new Map(), used: new Set(used) })
const all = (n: Net) => [...n.pool.entries(), ...n.chain.entries()]
const rpcError = (message: string, code = -32000) => Object.assign(new Error(message), { code })

/** One RPC endpoint over the shared pool. `send` decides what eth_sendRawTransaction does. */
function rpc(net: Net, send: (raw: Hex) => Hex, over: Record<string, (p: unknown[]) => unknown> = {}): EIP1193Provider {
  const handlers: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x1',
    eth_blockNumber: () => '0x10',
    eth_getBlockByNumber: () => BLOCK,
    eth_maxPriorityFeePerGas: () => '0x3b9aca00',
    eth_gasPrice: () => '0x6fc23ac00',
    eth_estimateGas: () => '0x5208',
    eth_getBalance: () => '0xde0b6b3a7640000',
    eth_getTransactionCount: () => '0x7',
    eth_call: () => '0x',
    eth_getTransactionByHash: (p) => {
      const raw = net.pool.get(p[0] as Hex) ?? net.chain.get(p[0] as Hex)
      if (!raw) return null
      const tx = parseTransaction(raw)
      return { hash: p[0], from: HARDHAT0, to: tx.to, nonce: `0x${tx.nonce!.toString(16)}`, value: '0x1', input: '0x', gas: '0x5208', type: '0x2', blockHash: null, blockNumber: null, transactionIndex: null }
    },
    eth_sendRawTransaction: (p) => send(p[0] as Hex),
    ...over,
  }
  return {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      const h = handlers[method]
      if (!h) throw new Error(`unmocked ${method}`)
      return h((params as unknown[]) ?? [])
    },
  } as unknown as EIP1193Provider
}

/** A geth-like node: "already known" for bytes in its pool, "nonce too low" for a nonce used on chain. */
const geth = (net: Net) => (raw: Hex): Hex => {
  const hash = keccak256(raw)
  if (net.pool.has(hash)) throw rpcError('already known')
  const nonce = parseTransaction(raw).nonce!
  if (net.used.has(nonce)) throw rpcError(`nonce too low: next nonce ${Math.max(...net.used) + 1}, tx nonce ${nonce}`)
  net.pool.set(hash, raw)
  return hash
}
/** The first RPC takes the tx into the pool, then the answer is lost (no JSON-RPC error object). */
const losesAnswer = (net: Net) => (raw: Hex): Hex => { geth(net)(raw); throw new Error('socket hang up') }
/** As above, and the tx is mined before the next RPC sees it: it leaves the pool, its nonce is used. */
const minedThenLost = (net: Net) => (raw: Hex): Hex => {
  const hash = keccak256(raw)
  net.chain.set(hash, raw)
  net.used.add(parseTransaction(raw).nonce!)
  throw new Error('socket hang up')
}

async function account(providers: EIP1193Provider[]) {
  const s = countingSigner()
  const a = await new WalletManagerEvm(s.signer, { provider: providers }).getAccount()
  return { a, ...s }
}

describe('failover never signs a second transaction for one send', () => {
  it('lost answer, then "already known" from the next RPC → one signature, its hash', async () => {
    const net = network()
    const { a, txSignatures } = await account([rpc(net, losesAnswer(net)), rpc(net, geth(net))])
    const res = await a.sendTransaction({ to: SPENDER, value: 1n })
    expect(txSignatures()).toBe(1)
    expect(all(net)).toHaveLength(1)
    expect(res.hash).toBe(all(net)[0]![0])
  })

  it('lost answer, the tx is mined, the next RPC says "nonce too low" → one signature, its hash', async () => {
    const net = network()
    const { a, txSignatures } = await account([rpc(net, minedThenLost(net)), rpc(net, geth(net))])
    const res = await a.sendTransaction({ to: SPENDER, value: 1n })
    expect(txSignatures()).toBe(1)
    expect(all(net)).toHaveLength(1)
    expect(res.hash).toBe(all(net)[0]![0])
  })

  it('the next send after a recovered broadcast takes the following nonce', async () => {
    const net = network()
    const { a } = await account([rpc(net, losesAnswer(net)), rpc(net, geth(net))])
    await a.sendTransaction({ to: SPENDER, value: 1n })
    await a.sendTransaction({ to: SPENDER, value: 2n }) // RPC `pending` still says 7
    expect(all(net).map(([, r]) => parseTransaction(r).nonce)).toEqual([7, 8])
  })

  it('a stale `pending` count ("nonce too low", tx not ours) is still re-signed once with the next nonce', async () => {
    const net = network([7, 8])
    const { a, txSignatures } = await account([rpc(net, geth(net))])
    const res = await a.sendTransaction({ to: SPENDER, value: 1n })
    expect(txSignatures()).toBe(2)
    expect(all(net).map(([, r]) => parseTransaction(r).nonce)).toEqual([9])
    expect(res.hash).toBe(all(net)[0]![0])
  })

  it('"replacement transaction underpriced" is not retried', async () => {
    const net = network()
    const { a, txSignatures } = await account([rpc(net, () => { throw rpcError('replacement transaction underpriced') })])
    await expect(a.sendTransaction({ to: SPENDER, value: 1n })).rejects.toThrow(/replacement transaction underpriced/)
    expect(txSignatures()).toBe(1)
  })

  it('"nonce too low" while the lookup of our own hash fails → maybe sent, never re-signed', async () => {
    const net = network()
    const lookupDown = { eth_getTransactionByHash: () => { throw new Error('socket hang up') } }
    const { a, txSignatures } = await account([rpc(net, minedThenLost(net), lookupDown), rpc(net, geth(net), lookupDown)])
    const err = await a.sendTransaction({ to: SPENDER, value: 1n }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BroadcastUnknownError)
    expect(err).toMatchObject({ maybeSent: true, hash: all(net)[0]![0] })
    expect(txSignatures()).toBe(1)
  })
})
