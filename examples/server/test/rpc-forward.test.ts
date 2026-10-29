import { describe, expect, it } from 'vitest'
import { createRpcProxy } from '../src/rpc.ts'

// Audit 2026-10-25 round 3, M29: the proxy validated the PARSED request and forwarded the RAW bytes.
// With a duplicated key — {"method":"eth_call", …, "method":"eth_sendRawTransaction"} — JSON.parse
// keeps the last one for the check while an upstream that keeps the first (or the reverse) runs the
// other method. What goes upstream is now the request that was checked, re-serialized.

describe('rpc proxy forwards exactly what it checked', () => {
  it('a duplicated key cannot smuggle a second method past the allowlist', async () => {
    const seen: string[] = []
    const proxy = createRpcProxy({
      upstreams: { 'eip155:1': ['https://eth.example'] },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.push(String(init.body))
        return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
    })
    const raw = '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"],"method":"eth_blockNumber"}'
    const out = await proxy('eip155:1', raw)
    expect(out.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toContain('eth_sendRawTransaction')
    expect(JSON.parse(seen[0]!)).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: ['0x00'] })
  })

  it('a batch goes upstream as the parsed batch', async () => {
    const seen: string[] = []
    const proxy = createRpcProxy({
      upstreams: { 'eip155:1': ['https://eth.example'] },
      fetchImpl: (async (_url: string, init: RequestInit) => { seen.push(String(init.body)); return new Response('[]') }) as unknown as typeof fetch,
    })
    await proxy('eip155:1', ' [ {"jsonrpc":"2.0","id":1,"method":"eth_chainId"} , {"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]} ] ')
    expect(seen[0]).toBe('[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},{"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]}]')
  })
})
