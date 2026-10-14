import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FetchLike } from '../src/index.js'

/** Public test wallet the fixtures were captured for (2026-10-14). */
export const ADDRESS = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'

const here = dirname(fileURLToPath(import.meta.url))

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8')) as T
}

type Row = Record<string, string>
interface Envelope {
  status: string
  message: string
  result: Row[]
}

export interface Recorded {
  url: string
  at: number
}

export interface FakeOptions {
  /** Etherscan-format rows (real fixtures by default). */
  etherscan?: { txlist: Row[]; tokentx: Row[]; txlistinternal: Row[] }
  /** Called before every Etherscan-format request; return a body to short-circuit (NOTOK simulations). */
  etherscanIntercept?: (url: URL, n: number) => unknown | undefined
  /** Blockscout page size (real instances use 50). */
  blockscoutPageSize?: number
  /** Called before every Blockscout request; return `{status, body}` to short-circuit. */
  blockscoutIntercept?: (url: URL, n: number) => { status: number; body?: unknown } | undefined
  /** Chain ids the fake `chainlist` endpoint reports (default: 1 and the fallback table). */
  chainlist?: number[]
  /** Every Alchemy request answers the captured `<NETWORK> is not enabled for this app` envelope (HTTP 403). */
  alchemyNotEnabled?: boolean
  /** Drop `metadata` from the Transfers API rows (a network without `withMetadata`) so the client must fetch block timestamps. */
  alchemyStripMetadata?: boolean
  /** Called before every Alchemy request with the parsed JSON-RPC body; return `{status, body}` to short-circuit. */
  alchemyIntercept?: (body: unknown, n: number) => { status: number; body?: unknown } | undefined
}

type RpcReq = { jsonrpc: string; id: number; method: string; params: unknown[] }

export function etherscanRows() {
  return {
    txlist: fixture<Envelope>('etherscan-eth-txlist.json').result,
    tokentx: fixture<Envelope>('etherscan-eth-tokentx.json').result,
    txlistinternal: fixture<Envelope>('etherscan-eth-txlistinternal.json').result,
  }
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

/**
 * Serves the captured fixtures the way the real explorers do: Etherscan lists
 * honour `endblock` / `offset` / `sort=desc`, the proxy module answers from the
 * captured JSON-RPC bodies, Blockscout lists page with `next_page_params`.
 */
export function fakeFetch(opts: FakeOptions = {}): FetchLike & { calls: Recorded[]; etherscanCalls: number; blockscoutCalls: number; alchemyCalls: number; alchemyBodies: unknown[] } {
  const rows = opts.etherscan ?? etherscanRows()
  const pageSize = opts.blockscoutPageSize ?? 50
  const calls: Recorded[] = []
  let etherscanCalls = 0, blockscoutCalls = 0, alchemyCalls = 0
  const alchemyBodies: unknown[] = []

  const bsTx = fixture<{ items: Record<string, unknown>[] }>('blockscout-eth-transactions.json').items
  const bsTt = fixture<{ items: Record<string, unknown>[] }>('blockscout-eth-token-transfers.json').items
  const bsIt = fixture<{ items: Record<string, unknown>[] }>('blockscout-eth-internal-transactions.json').items

  const alFrom = fixture<{ result: { transfers: Record<string, unknown>[] } }>('alchemy-base-transfers-from.json').result.transfers
  const alTo = fixture<{ result: { transfers: Record<string, unknown>[] } }>('alchemy-base-transfers-to.json').result.transfers
  const alTx = fixture<Record<string, { tx: Record<string, unknown>; receipt: Record<string, unknown> }>>('alchemy-base-tx-receipts.json')
  const alTxLower: Record<string, { tx: Record<string, unknown>; receipt: Record<string, unknown> }> = {}
  for (const [h, v] of Object.entries(alTx)) alTxLower[h.toLowerCase()] = v

  const alchemyAnswer = (req: RpcReq): unknown => {
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result })
    if (req.method === 'alchemy_getAssetTransfers') {
      const p = (req.params[0] ?? {}) as Record<string, unknown>
      const dir = typeof p['fromAddress'] === 'string' ? 'from' : typeof p['toAddress'] === 'string' ? 'to' : undefined
      if (!dir) return { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'fromAddress or toAddress required' } }
      const addr = String(p['fromAddress'] ?? p['toAddress']).toLowerCase()
      let list = addr === ADDRESS.toLowerCase() ? (dir === 'from' ? alFrom : alTo) : []
      const cats = Array.isArray(p['category']) ? (p['category'] as string[]) : []
      list = list.filter((t) => cats.includes(String(t['category'])))
      const toBlock = typeof p['toBlock'] === 'string' ? parseInt(p['toBlock'], 16) : Number.MAX_SAFE_INTEGER
      list = list.filter((t) => parseInt(String(t['blockNum']), 16) <= toBlock)
      const max = typeof p['maxCount'] === 'string' ? parseInt(p['maxCount'], 16) : 1000
      let page = list.slice(0, max)
      if (opts.alchemyStripMetadata) page = page.map(({ metadata: _m, ...rest }) => rest)
      const result: Record<string, unknown> = { transfers: page }
      if (list.length > max) result['pageKey'] = '00000000-0000-4000-8000-' + String(alchemyCalls).padStart(12, '0')
      return ok(result)
    }
    if (req.method === 'eth_getTransactionByHash') return ok(alTxLower[String(req.params[0]).toLowerCase()]?.tx ?? null)
    if (req.method === 'eth_getTransactionReceipt') return ok(alTxLower[String(req.params[0]).toLowerCase()]?.receipt ?? null)
    if (req.method === 'eth_getBlockByNumber') {
      const n = parseInt(String(req.params[0]), 16)
      return ok({ number: req.params[0], timestamp: '0x' + (1_790_000_000 + n).toString(16) })
    }
    if (req.method === 'eth_chainId') return ok('0x2105')
    return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Unsupported method: ' + req.method } }
  }

  const f = (async (input: string, init?: { body?: string }) => {
    calls.push({ url: input, at: Date.now() })
    const url = new URL(input)

    // Alchemy is the only JSON-RPC (POST) backend; a proxy host (alchemyUrl) is routed here too.
    if (url.hostname.endsWith('.g.alchemy.com') || init?.body) {
      alchemyCalls++
      const body = init?.body ? (JSON.parse(init.body) as unknown) : null
      alchemyBodies.push(body)
      const intercepted = opts.alchemyIntercept?.(body, alchemyCalls)
      if (intercepted) return jsonResponse(intercepted.status, intercepted.body ?? { error: 'intercepted' })
      if (opts.alchemyNotEnabled) return jsonResponse(403, fixture('alchemy-not-enabled.json'))
      if (Array.isArray(body)) return jsonResponse(200, (body as RpcReq[]).map(alchemyAnswer))
      return jsonResponse(200, alchemyAnswer(body as RpcReq))
    }

    if (url.pathname === '/v2/chainlist') {
      const ids = opts.chainlist ?? [1, 8453, 42161, 10, 137, 56, 43114, 100, 130, 143, 999, 146, 80094, 59144, 42220, 9745, 4326, 4663, 480, 1329]
      return jsonResponse(200, { comments: 'fake', totalcount: ids.length, result: ids.map((id) => ({ chainname: `chain ${id}`, chainid: String(id), blockexplorer: 'https://x', apiurl: 'https://api.etherscan.io/v2/api?chainid=' + id, status: 1 })) })
    }

    if (url.searchParams.has('module')) {
      etherscanCalls++
      const intercepted = opts.etherscanIntercept?.(url, etherscanCalls)
      if (intercepted !== undefined) return jsonResponse(200, intercepted)
      const module = url.searchParams.get('module'), action = url.searchParams.get('action')
      if (module === 'account') {
        const list = action === 'txlist' ? rows.txlist : action === 'tokentx' ? rows.tokentx : action === 'txlistinternal' ? rows.txlistinternal : undefined
        if (!list) return jsonResponse(200, { status: '0', message: 'NOTOK', result: 'Error! Missing Or invalid Action name' })
        const endblock = Number(url.searchParams.get('endblock') ?? 99_999_999)
        const startblock = Number(url.searchParams.get('startblock') ?? 0)
        const offset = Number(url.searchParams.get('offset') ?? 10)
        const page = Number(url.searchParams.get('page') ?? 1)
        const sorted = [...list].filter((r) => Number(r['blockNumber']) <= endblock && Number(r['blockNumber']) >= startblock).sort((a, b) => Number(b['blockNumber']) - Number(a['blockNumber']))
        const slice = sorted.slice((page - 1) * offset, page * offset)
        return jsonResponse(200, slice.length ? { status: '1', message: 'OK', result: slice } : { status: '0', message: 'No transactions found', result: [] })
      }
      if (module === 'proxy') {
        const tx = fixture<{ result: Record<string, unknown> }>('etherscan-eth-proxy-tx.json')
        const receipt = fixture<{ result: Record<string, unknown> }>('etherscan-eth-proxy-receipt.json')
        const block = fixture<{ result: Record<string, unknown> }>('etherscan-eth-proxy-block.json')
        const hash = url.searchParams.get('txhash')
        if (action === 'eth_getTransactionByHash') return jsonResponse(200, hash?.toLowerCase() === String(tx.result['hash']).toLowerCase() ? tx : { jsonrpc: '2.0', id: 1, result: null })
        if (action === 'eth_getTransactionReceipt') return jsonResponse(200, hash?.toLowerCase() === String(receipt.result['transactionHash']).toLowerCase() ? receipt : { jsonrpc: '2.0', id: 1, result: null })
        if (action === 'eth_getBlockByNumber') return jsonResponse(200, block)
      }
      return jsonResponse(200, { status: '0', message: 'NOTOK', result: 'unknown module' })
    }

    if (url.pathname.startsWith('/api/v2/')) {
      blockscoutCalls++
      const intercepted = opts.blockscoutIntercept?.(url, blockscoutCalls)
      if (intercepted) return jsonResponse(intercepted.status, intercepted.body ?? { message: 'intercepted' })
      const m = url.pathname.match(/^\/api\/v2\/addresses\/([^/]+)\/(transactions|token-transfers|internal-transactions)$/)
      if (m) {
        if (m[1]!.toLowerCase() !== ADDRESS.toLowerCase()) return jsonResponse(404, { message: 'Not found' })
        const list = m[2] === 'transactions' ? bsTx : m[2] === 'token-transfers' ? bsTt : bsIt
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const items = list.slice(offset, offset + pageSize)
        const next = offset + pageSize < list.length ? { offset: offset + pageSize, items_count: pageSize, block_number: items[items.length - 1]?.['block_number'] } : null
        return jsonResponse(200, { items, next_page_params: next })
      }
      const t = url.pathname.match(/^\/api\/v2\/transactions\/([^/]+)(\/token-transfers|\/internal-transactions)?$/)
      if (t) {
        const detail = fixture<Record<string, unknown>>('blockscout-eth-tx.json')
        if (t[1]!.toLowerCase() !== String(detail['hash']).toLowerCase()) return jsonResponse(404, { message: 'Not found' })
        if (!t[2]) return jsonResponse(200, detail)
        if (t[2] === '/token-transfers') return jsonResponse(200, fixture('blockscout-eth-tx-token-transfers.json'))
        return jsonResponse(200, { items: [], next_page_params: null })
      }
      if (url.pathname === '/api/v2/transactions') return jsonResponse(200, { items: bsTx.slice(0, 5), next_page_params: null })
      return jsonResponse(404, { message: 'Not found' })
    }
    return jsonResponse(404, { message: 'unrouted ' + input })
  }) as FetchLike & { calls: Recorded[]; etherscanCalls: number; blockscoutCalls: number; alchemyCalls: number; alchemyBodies: unknown[] }
  Object.defineProperty(f, 'calls', { get: () => calls })
  Object.defineProperty(f, 'etherscanCalls', { get: () => etherscanCalls })
  Object.defineProperty(f, 'blockscoutCalls', { get: () => blockscoutCalls })
  Object.defineProperty(f, 'alchemyCalls', { get: () => alchemyCalls })
  Object.defineProperty(f, 'alchemyBodies', { get: () => alchemyBodies })
  return f
}

/** Synthetic Etherscan rows for cases the real wallet does not have: a 3-leg swap, a failed tx, a bulk airdrop, a fake-USDT dust transfer. */
export function syntheticRows(address = ADDRESS.toLowerCase()) {
  const base = (hash: string, block: number, extra: Partial<Row> = {}): Row => ({
    blockNumber: String(block),
    blockHash: '0x' + 'b'.repeat(64),
    timeStamp: String(1_790_000_000 + block),
    hash,
    nonce: '1',
    transactionIndex: '1',
    from: address,
    to: '0x1111111111111111111111111111111111111111',
    value: '0',
    gas: '200000',
    gasPrice: '1000000000',
    input: '0x12345678' + '0'.repeat(64),
    methodId: '0x12345678',
    functionName: 'swap()',
    contractAddress: '',
    cumulativeGasUsed: '1',
    gasUsed: '100000',
    confirmations: '10',
    isError: '0',
    txreceipt_status: '1',
    ...extra,
  })
  const tok = (hash: string, block: number, token: string, symbol: string, from: string, to: string, value: string, decimals = '18'): Row => ({
    ...base(hash, block),
    from,
    to,
    value,
    contractAddress: token,
    tokenName: symbol,
    tokenSymbol: symbol,
    tokenDecimal: decimals,
  })
  const SWAP = '0x' + '1'.repeat(64), FAILED = '0x' + '2'.repeat(64), AIRDROP = '0x' + '3'.repeat(64), FAKE = '0x' + '4'.repeat(64), SEND = '0x' + '5'.repeat(64)
  const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', UNKNOWN = '0x9999999999999999999999999999999999999999'
  const router = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222', attacker = '0x3333333333333333333333333333333333333333'
  return {
    hashes: { SWAP, FAILED, AIRDROP, FAKE, SEND },
    txlist: [
      base(SWAP, 1000, { value: '1000000000000000000' }), // 1 ETH in, 3 token legs
      base(FAILED, 999, { isError: '1', txreceipt_status: '0', gasUsed: '50000' }),
      base(SEND, 998, { to: other, value: '5000000000000000', input: '0x', methodId: '', functionName: '' }),
      base(AIRDROP, 997, { from: attacker, to: UNKNOWN }),
    ],
    tokentx: [
      tok(SWAP, 1000, WETH, 'WETH', router, address, '1000000000000000000'),
      tok(SWAP, 1000, WETH, 'WETH', address, router, '1000000000000000000'),
      tok(SWAP, 1000, USDT, 'USDT', router, address, '3000000000', '6'),
      ...Array.from({ length: 20 }, (_, i) => tok(AIRDROP, 997, UNKNOWN, 'FREE', attacker, i === 0 ? address : other, '1000')),
      tok(FAKE, 996, UNKNOWN, 'USDT', attacker, address, '15000000', '6'), // fake USDT at an unknown contract
    ],
    txlistinternal: [
      { ...base(SWAP, 1000), from: router, to: address, value: '250000000000000', type: 'call', traceId: '0_1', errCode: '', input: '' },
      { ...base(SWAP, 1000), from: router, to: address, value: '0', type: 'call', traceId: '0_2', errCode: '', input: '' },
    ],
  }
}
