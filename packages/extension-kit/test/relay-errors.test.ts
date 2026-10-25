import { describe, expect, it } from 'vitest'
import { HttpRequestError, InvalidInputRpcError, RpcRequestError, TimeoutError } from 'viem'
import { UserRejectedError } from '@anywalletkit/core'
import { RELAY_ERRORS, ReviewDeclined, RouterError, toRelayError } from '../src/index.js'

// Audit 2026-10-25, finding 8: an internal error reached the dApp page as is — viem's messages
// carry the RPC URL (often with the provider key in the path) and the request body.

const KEY = 'sk_live_9f8e7d6c5b4a'
const URL_WITH_KEY = `https://eth-mainnet.example-rpc.io/v2/${KEY}`
const REVERT = '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000c6e6f7420616c6c6f7765640000000000000000000000000000000000000000'
const page = (e: unknown, log?: (e: unknown) => void) => JSON.stringify(toRelayError(e, log ? { log } : undefined))

describe('toRelayError: what a page may see', () => {
  it('a transport failure with the key in the URL and a header → -32603 "Internal error", logged in full', () => {
    const logged: unknown[] = []
    const http = new HttpRequestError({ url: URL_WITH_KEY, status: 502, body: { method: 'eth_call' }, details: `upstream ${URL_WITH_KEY} failed`, headers: new Headers({ authorization: `Bearer ${KEY}` }) })
    for (const e of [http, new TimeoutError({ body: { method: 'eth_call' }, url: URL_WITH_KEY }), new TypeError(`fetch ${URL_WITH_KEY} failed`), Object.assign(new Error(`x-api-key: ${KEY}`), { code: 'ECONNRESET' })]) {
      const out = page(e, (err) => logged.push(err))
      expect(out).not.toContain(KEY)
      expect(JSON.parse(out)).toEqual({ code: RELAY_ERRORS.internal, message: 'Internal error' })
    }
    expect(logged).toHaveLength(4) // the extension's own log keeps the details
  })

  it('a node revert keeps its code and data, without the URL or the request body', () => {
    const node = new RpcRequestError({ body: { method: 'eth_call', params: [{ to: '0x1' }] }, error: { code: 3, message: 'execution reverted: not allowed', data: REVERT }, url: URL_WITH_KEY })
    const out = page(node)
    expect(out).not.toContain(KEY)
    expect(out).not.toContain('Request body')
    expect(JSON.parse(out)).toEqual({ code: 3, message: 'execution reverted: not allowed', data: REVERT })
    // the same error wrapped by viem's typed RPC errors
    const wrapped = new InvalidInputRpcError(new RpcRequestError({ body: { method: 'eth_estimateGas' }, error: { code: -32000, message: `insufficient funds (see ${URL_WITH_KEY})` }, url: URL_WITH_KEY }))
    const w = JSON.parse(page(wrapped))
    expect(JSON.stringify(w)).not.toContain(KEY)
    expect(w).toMatchObject({ code: -32000 })
    expect(w.message).toMatch(/insufficient funds/)
  })

  it('a JSON-RPC error object from a fetch-based transport passes, URLs redacted', () => {
    const out = page({ code: -32005, message: `rate limited, upgrade at ${URL_WITH_KEY}` })
    expect(out).not.toContain(KEY)
    expect(JSON.parse(out)).toMatchObject({ code: -32005 })
  })

  it('wallet errors keep their EIP-1193 codes; URLs in their messages are redacted', () => {
    expect(toRelayError(new ReviewDeclined())).toEqual({ code: 4001, message: 'You declined — nothing was signed.' })
    expect(toRelayError(new UserRejectedError())).toMatchObject({ code: 4001 })
    expect(toRelayError(new RouterError(4200, 'This wallet does not support foo_bar.'))).toEqual({ code: 4200, message: 'This wallet does not support foo_bar.' })
    const added = page(new RouterError(RELAY_ERRORS.invalidParams, `The RPC for X did not answer eth_chainId (HTTP request failed. URL: ${URL_WITH_KEY}); the network was not added.`))
    expect(added).not.toContain(KEY)
    expect(JSON.parse(added)).toMatchObject({ code: RELAY_ERRORS.invalidParams })
  })

  it('an internal error with a numeric code of its own is still internal', () => {
    // viem's UnknownRpcError is code -1; a stray number must not turn an internal error into a node error
    expect(JSON.parse(page(Object.assign(new Error(`boom at ${URL_WITH_KEY}`), { code: -1 })))).toEqual({ code: RELAY_ERRORS.internal, message: 'Internal error' })
    expect(JSON.parse(page(Object.assign(new Error('vault'), { code: 7 })))).toEqual({ code: RELAY_ERRORS.internal, message: 'Internal error' })
  })
})
