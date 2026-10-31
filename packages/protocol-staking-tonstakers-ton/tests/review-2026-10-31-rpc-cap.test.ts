import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import '../src/buffer-global.js'
import TonstakersProtocolTon from '../index.js'

// A TON node's answer is capped at 1 MiB before @ton/ton's schemas validate it, on both the
// `{ url }` endpoint path (fetch, Node and React Native) and the TonRpc path.

const OWNER = 'UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG'
const INFO = {
  balance: '123000000000', state: 'active', data: '', code: '',
  last_transaction_id: { '@type': 'internal.transactionId', lt: '0', hash: '' },
  block_id: { '@type': 'ton.blockIdExt', workchain: -1, shard: '-9223372036854775808', seqno: 1, root_hash: '', file_hash: '' },
  sync_utime: 0,
}
const ok = JSON.stringify({ ok: true, result: INFO })
const huge = JSON.stringify({ ok: true, result: { ...INFO, data: 'A'.repeat(2 * 1024 * 1024) } })
const account = (config: object) => ({ chain: 'ton:-239', async getAddress() { return OWNER }, _config: config })

let mode: 'ok' | 'huge-chunked' | 'huge-declared' | 'error' = 'ok'
const seen: { headers: IncomingMessage['headers']; method: string | undefined; body: string }[] = []
let server: Server
let url = ''
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ headers: req.headers, method: req.method, body })
      if (mode === 'error') { res.writeHead(500); return res.end('upstream down') }
      if (mode === 'huge-declared') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(huge.length) }); return res.end(huge) }
      res.writeHead(200, { 'content-type': 'application/json' }) // chunked: no content-length
      if (mode === 'ok') return res.end(ok)
      for (let i = 0; i < huge.length; i += 64 * 1024) res.write(huge.slice(i, i + 64 * 1024))
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jsonRPC`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))
afterEach(() => { mode = 'ok'; seen.length = 0; vi.unstubAllGlobals() })

describe('endpoint { url, secretKey }', () => {
  it('control: a normal answer is read, with the API key and the JSON-RPC body sent', async () => {
    const p = new TonstakersProtocolTon(account({ tonClient: { url, secretKey: 'k-1' } }))
    expect(await p.getInstantLiquidity()).toBe(123_000_000_000n)
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.headers['x-api-key']).toBe('k-1')
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ jsonrpc: '2.0', method: 'getAddressInformation' })
  })

  it('a streamed answer past 1 MiB is refused', async () => {
    mode = 'huge-chunked'
    const p = new TonstakersProtocolTon(account({ tonClient: { url } }))
    await expect(p.getInstantLiquidity()).rejects.toThrow(/larger than 1 MiB/)
  })

  it('a declared content-length past 1 MiB is refused unread', async () => {
    mode = 'huge-declared'
    const p = new TonstakersProtocolTon(account({ tonClient: { url } }))
    await expect(p.getInstantLiquidity()).rejects.toThrow(/larger than 1 MiB/)
  })

  it('an HTTP error still fails the call', async () => {
    mode = 'error'
    const p = new TonstakersProtocolTon(account({ tonClient: { url } }))
    await expect(p.getInstantLiquidity()).rejects.toThrow()
  })

  it('React Native style fetch (no body stream): the text is capped too, a small answer passes', async () => {
    const rn = (text: string) => vi.fn(async () => ({ status: 200, statusText: 'OK', headers: { get: () => null }, text: async () => text }))
    vi.stubGlobal('fetch', rn(huge))
    await expect(new TonstakersProtocolTon(account({ tonClient: { url: 'https://rpc.example/jsonRPC' } })).getInstantLiquidity()).rejects.toThrow(/larger than 1 MiB/)
    vi.stubGlobal('fetch', rn(ok))
    expect(await new TonstakersProtocolTon(account({ tonClient: { url: 'https://rpc.example/jsonRPC' } })).getInstantLiquidity()).toBe(123_000_000_000n)
  })
})

describe('TonRpc { call }', () => {
  it('an oversized result is refused before @ton/ton parses it; a normal one passes', async () => {
    const rpc = (result: unknown) => ({ async call() { return result } })
    await expect(new TonstakersProtocolTon(account({ provider: rpc(JSON.parse(huge).result) })).getInstantLiquidity()).rejects.toThrow(/larger than 1 MiB/)
    expect(await new TonstakersProtocolTon(account({ provider: rpc(INFO) })).getInstantLiquidity()).toBe(123_000_000_000n)
  })
})
