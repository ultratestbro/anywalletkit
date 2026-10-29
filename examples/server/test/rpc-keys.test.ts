import { describe, expect, it } from 'vitest'
import { createRpcProxy } from '../src/rpc.ts'

// Scan 2026-10-28 F8: the proxy checked `method`/`params` and forwarded the whole parsed object.
// Go's encoding/json (geth-style nodes) matches keys case-insensitively, last key wins, so a
// "Method":"debug_traceCall" next to an allowed "method" ran upstream unchecked. Each call is now
// rebuilt from { jsonrpc, id, method, params }, and any other key, case variants included, is refused.

function setup() {
  const seen: string[] = []
  const proxy = createRpcProxy({
    upstreams: { 'eip155:1': ['https://eth.example'] },
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seen.push(String(init.body))
      return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch,
  })
  return { seen, proxy }
}

describe('rpc proxy forwards only the four checked keys', () => {
  it('refuses "Method"/"Params" case variants next to an allowed method', async () => {
    const { seen, proxy } = setup()
    const body = '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[],"Method":"debug_traceCall","Params":[{"to":"0x0000000000000000000000000000000000000000"},"latest",{"tracer":"callTracer"}]}'
    const out = await proxy('eip155:1', body)
    expect(out.status).toBe(400)
    expect(seen).toHaveLength(0)
  })

  it.each([
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","PARAMS":[]}',
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[],"extra":1}',
    '{"JSONRPC":"2.0","id":1,"method":"eth_chainId"}',
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":{"a":1}}',
    '{"jsonrpc":"1.0","id":1,"method":"eth_chainId","params":[]}',
    '{"jsonrpc":"2.0","id":{},"method":"eth_chainId","params":[]}',
    '[{"jsonrpc":"2.0","id":1,"method":"eth_chainId"},{"jsonrpc":"2.0","id":2,"method":"eth_chainId","mEthod":"admin_peers"}]',
    '[1]',
  ])('refuses %s', async (body) => {
    const { seen, proxy } = setup()
    const out = await proxy('eip155:1', body)
    expect(out.status).toBe(400)
    expect(seen).toHaveLength(0)
  })

  it('forwards a clean call rebuilt from the checked fields', async () => {
    const { seen, proxy } = setup()
    const out = await proxy('eip155:1', '{"params":["0xabc","latest"],"method":"eth_getBalance","id":"a","jsonrpc":"2.0"}')
    expect(out.status).toBe(200)
    expect(seen[0]).toBe('{"jsonrpc":"2.0","id":"a","method":"eth_getBalance","params":["0xabc","latest"]}')
  })

  it('a plain debug_traceCall is still refused', async () => {
    const { seen, proxy } = setup()
    const out = await proxy('eip155:1', '{"jsonrpc":"2.0","id":2,"method":"debug_traceCall","params":[]}')
    expect(out.status).toBe(403)
    expect(seen).toHaveLength(0)
  })
})
