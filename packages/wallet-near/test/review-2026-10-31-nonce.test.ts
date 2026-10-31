import { describe, expect, it } from 'vitest'
import { NearRpcError, WalletManagerNear, decodeSignedTransaction, fromBase64, type NearFetch } from '../src/index.js'
import { SEED, fakeNode } from './fake-node.js'

// The access key nonce is read at `final`, which lags the block holding our last transaction: two
// awaited sends both signed finalized nonce + 1, and the second was refused with InvalidNonce. The
// account now keeps its last broadcast nonce and serializes its sends.

/** A node whose finalized access key stays at 41 while our transactions land; a reused nonce is refused. */
function laggingNode(sendError?: (n: bigint) => unknown) {
  const base = fakeNode()
  const used = new Set<bigint>()
  const signed: bigint[] = []
  const fetch: NearFetch = async (method, params) => {
    const p = params as Record<string, unknown>
    if (method === 'query' && p.request_type === 'view_access_key') return { nonce: p.finality === 'final' ? 41 : 41 + used.size, permission: 'FullAccess' }
    if (method === 'send_tx') {
      const n = BigInt(decodeSignedTransaction(fromBase64(p.signed_tx_base64 as string)).transaction.nonce)
      signed.push(n)
      const err = sendError?.(n)
      if (err) throw err
      if (used.has(n)) throw new NearRpcError('send_tx', { name: 'INVALID_TRANSACTION', cause: { name: 'INVALID_TRANSACTION', info: { InvalidNonce: { tx_nonce: Number(n), ak_nonce: Number(n) } } }, message: 'InvalidNonce' })
      used.add(n)
    }
    return base.fetch(method, params)
  }
  return { fetch, signed }
}

describe('NEAR nonces across sends', () => {
  it('two awaited transfers sign 42 then 43', async () => {
    const net = laggingNode()
    const a = await new WalletManagerNear(SEED, { provider: net.fetch }).getAccount(0)
    await a.transfer({ recipient: 'alice.near', amount: 1n })
    await a.transfer({ recipient: 'alice.near', amount: 1n })
    expect(net.signed).toEqual([42n, 43n])
  })

  it('two concurrent sends are serialized and sign distinct nonces', async () => {
    const net = laggingNode()
    const a = await new WalletManagerNear(SEED, { provider: net.fetch }).getAccount(0)
    const tx = { receiverId: 'alice.near', actions: [{ transfer: { deposit: 1n } }] }
    await Promise.all([a.transfer({ recipient: 'alice.near', amount: 1n }), a.sendTransaction(tx as never)])
    expect(net.signed).toEqual([42n, 43n])
  })

  it('a definitive refusal does not raise the floor; a maybe-sent broadcast does', async () => {
    let mode: 'refuse' | 'timeout' | 'ok' = 'refuse'
    const net = laggingNode(() => {
      if (mode === 'refuse') return new NearRpcError('send_tx', { name: 'INVALID_TRANSACTION', cause: { name: 'INVALID_TRANSACTION', info: { NotEnoughBalance: {} } }, message: 'NotEnoughBalance' })
      if (mode === 'timeout') return new Error('fetch failed')
      return undefined
    })
    const a = await new WalletManagerNear(SEED, { provider: net.fetch }).getAccount(0)
    await expect(a.transfer({ recipient: 'alice.near', amount: 1n })).rejects.toThrow()
    mode = 'timeout'
    await expect(a.transfer({ recipient: 'alice.near', amount: 1n })).rejects.toMatchObject({ name: 'BroadcastUnknownError' })
    mode = 'ok'
    await a.transfer({ recipient: 'alice.near', amount: 1n })
    // refused 42 is reused; the maybe-sent 42 is not
    expect(net.signed).toEqual([42n, 42n, 43n])
  })

  it('an explicit caller nonce is signed as given', async () => {
    const net = laggingNode()
    const a = await new WalletManagerNear(SEED, { provider: net.fetch }).getAccount(0)
    await a.transfer({ recipient: 'alice.near', amount: 1n })
    await a.sendTransaction({ receiverId: 'alice.near', nonce: 100n, actions: [{ transfer: { deposit: 1n } }] } as never)
    expect(net.signed).toEqual([42n, 100n])
  })
})
