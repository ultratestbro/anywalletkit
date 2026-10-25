import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSignatureFromTransaction, getSolanaErrorFromJsonRpcError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError, type Address } from '@solana/kit'
import { NetworkError } from '@anywalletkit/core'
import { createRpc, decodeWireTransaction, WalletManagerSolana, type SolanaConfig, type SolanaRpc } from '../src/index.js'
import * as solana from '../src/index.js'

// Audit 2026-10-25 (post-release), M3: a lost sendTransaction answer surfaced as a generic error, so
// the caller re-planned (new blockhash = a second signature that also lands), and a url provider had
// no timeout at all.
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'
const BroadcastUnknownError = (solana as unknown as { BroadcastUnknownError?: new (...a: never[]) => Error }).BroadcastUnknownError

function fakeRpc(send: (wire: string) => unknown) {
  const sent: string[] = []
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    simulateTransaction: () => ({ value: { err: null, unitsConsumed: 50_000n, logs: [] } }),
    getFeeForMessage: () => ({ value: 5_000n }),
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getBalance: () => ({ value: 1n }),
    sendTransaction: (wire) => { sent.push(wire as string); return send(wire as string) },
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, sent }
}
const account = async (config: SolanaConfig) => new WalletManagerSolana(SEED, { priorityFee: false, ...config }).getAccount(0)
const preflight = () => getSolanaErrorFromJsonRpcError({ code: -32002, message: 'Transaction simulation failed: Blockhash not found', data: {} })
const signatureOf = (wire: string) => getSignatureFromTransaction(decodeWireTransaction(wire))

afterEach(() => { vi.unstubAllGlobals() })

describe('Solana broadcast outcome and RPC timeouts', () => {
  it('exports BroadcastUnknownError', () => {
    expect(BroadcastUnknownError).toBeTypeOf('function')
  })

  it('a send with no answer throws BroadcastUnknownError with the locally computed signature — sendTransaction and transfer', async () => {
    const f = fakeRpc(() => { throw new TypeError('fetch failed') })
    const a = await account({ provider: f.rpc })
    const err = await a.sendTransaction({ to: OTHER, value: 1n }).catch((e: unknown) => e) as { name: string; maybeSent: boolean; hash: string }
    expect(err).toMatchObject({ name: 'BroadcastUnknownError', maybeSent: true })
    expect(err.hash).toBe(signatureOf(f.sent[0]!))
    await expect(a.transfer({ recipient: OTHER, amount: 1n })).rejects.toMatchObject({ name: 'BroadcastUnknownError', maybeSent: true })
    expect(f.sent).toHaveLength(2)
  })

  it('an HTTP 4xx (rate limit, auth) is a refusal; a 408 / 5xx may have been forwarded (review round)', async () => {
    const http = (statusCode: number) => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { statusCode, message: 'x', headers: new Headers() })
    for (const [status, name] of [[429, 'SolanaError'], [401, 'SolanaError'], [403, 'SolanaError'], [408, 'BroadcastUnknownError'], [502, 'BroadcastUnknownError'], [504, 'BroadcastUnknownError']] as const) {
      const a = await account({ provider: fakeRpc(() => { throw http(status) }).rpc })
      expect([status, (await a.sendTransaction({ to: OTHER, value: 1n }).catch((e: unknown) => e) as Error).name]).toEqual([status, name])
    }
  })

  it('a definitive refusal from the node stays a clean failure', async () => {
    const f = fakeRpc(() => { throw preflight() })
    const a = await account({ provider: f.rpc })
    const err = await a.sendTransaction({ to: OTHER, value: 1n }).catch((e: unknown) => e) as Error
    expect(err.name).toBe('SolanaError')
    expect(err).not.toHaveProperty('maybeSent')
  })

  it('failover re-sends the same bytes; refused everywhere is a clean failure, refused after an unanswered attempt is "maybe sent"', async () => {
    const refusesA = fakeRpc(() => { throw preflight() })
    const refusesB = fakeRpc(() => { throw preflight() })
    const refused = await account({ provider: [refusesA.rpc, refusesB.rpc], retries: 0 })
    await expect(refused.sendTransaction({ to: OTHER, value: 1n })).rejects.toMatchObject({ name: 'SolanaError' })
    expect(refusesB.sent).toEqual(refusesA.sent)

    const second = fakeRpc(() => 'B'.repeat(87))
    const rescued = await account({ provider: [fakeRpc(() => { throw preflight() }).rpc, second.rpc], retries: 0 })
    await expect(rescued.sendTransaction({ to: OTHER, value: 1n })).resolves.toMatchObject({ hash: 'B'.repeat(87) })

    const lost = fakeRpc(() => { throw new TypeError('fetch failed') })
    const refuses = fakeRpc(() => { throw preflight() })
    const b = await account({ provider: [lost.rpc, refuses.rpc], retries: 0 })
    const err = await b.sendTransaction({ to: OTHER, value: 1n }).catch((e: unknown) => e) as { name: string; hash: string }
    expect(err).toMatchObject({ name: 'BroadcastUnknownError', maybeSent: true })
    // the same signed bytes went to both providers: failover never re-signs
    expect(refuses.sent).toEqual(lost.sent)
    expect(err.hash).toBe(signatureOf(lost.sent[0]!))

    // an answered send after a lost one is a success
    const ok = await account({ provider: [fakeRpc(() => { throw new TypeError('fetch failed') }).rpc, second.rpc], retries: 0 })
    await expect(ok.sendTransaction({ to: OTHER, value: 1n })).resolves.toMatchObject({ hash: 'B'.repeat(87) })
  })

  it('the Rpc createRpc returns is not a thenable and keeps kit\'s pending-request surface (review round)', async () => {
    const settle = async (rpc: unknown) => Promise.race([(async () => rpc)(), new Promise((r) => setTimeout(() => r('HUNG'), 300))])
    const one = createRpc({ provider: 'https://rpc.invalid' })!
    const many = createRpc({ provider: ['https://rpc-a.invalid', 'https://rpc-b.invalid'] })!
    expect(await settle(one)).toBe(one)
    expect(await settle(many)).toBe(many)
    expect(String(one)).toBe('[object Object]')
    expect(typeof (one.getBalance(OTHER) as unknown as { reactiveStore?: unknown }).reactiveStore).toBe('function')
  })

  it('url providers time out: reads with NetworkError, a send with BroadcastUnknownError', async () => {
    const answers: Record<string, unknown> = {
      getLatestBlockhash: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } },
      getFeeForMessage: { context: { slot: 1 }, value: 5000 },
    }
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal; body?: string }) => new Promise<Response>((resolve, reject) => {
      const { id, method } = JSON.parse(init?.body ?? '{}') as { id: number; method: string }
      methods.push(method)
      if (method in answers) return resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id, result: answers[method] })))
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')))
    })))
    const a = await account({ provider: 'https://rpc.invalid', timeoutMs: 50, simulate: false })
    const started = Date.now()
    const read = await a.getBalance().catch((e: unknown) => e)
    expect(read).toBeInstanceOf(NetworkError)
    expect((read as Error).message).toMatch(/no answer within 50 ms/)
    const sent = await a.sendTransaction({ to: OTHER, value: 1n }).catch((e: unknown) => e)
    expect(sent).toMatchObject({ name: 'BroadcastUnknownError', maybeSent: true })
    expect(methods).toContain('sendTransaction')
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 5_000)
})
