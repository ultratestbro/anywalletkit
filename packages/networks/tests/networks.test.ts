import { describe, expect, it } from 'vitest'
import {
  BUILTIN_NETWORKS, CATALOG_NETWORKS, DEFAULT_TESTNETS, EVM_MAINNETS, NetworkError, NetworksTable, caip2FromChainId, chainHex, checkRpcUrl, expectedIdentity,
  familyOf, isAddChainError, isCatalogChain, isPrivateHost, memoryJsonStorage, parseAddChainParams, parseUrl, tonGlobalIdFromBoc, verifyNetwork, verifyRpcs,
  type FetchLike, type Network, type NetworksState,
} from '../src/index.js'

const table = (initial: NetworksState | null = null) => new NetworksTable(memoryJsonStorage<NetworksState>(initial))

describe('catalog', () => {
  it('ships every mainnet with https endpoints and unique CAIP-2 ids', () => {
    const ids = new Set<string>()
    for (const n of BUILTIN_NETWORKS) {
      expect(ids.has(n.caip2), n.caip2).toBe(false)
      ids.add(n.caip2)
      expect(familyOf(n.caip2)).toBe(n.family)
      expect(n.source).toBe('builtin')
      for (const u of n.rpcs) expect(u.startsWith('https://'), u).toBe(true)
      expect(expectedIdentity(n.caip2)?.family, n.caip2).toBe(n.family)
    }
    expect(CATALOG_NETWORKS.every((n) => n.kind === 'catalog' && n.enabled)).toBe(true)
    expect(DEFAULT_TESTNETS.every((n) => n.kind === 'testnet' && !n.enabled)).toBe(true)
    expect(EVM_MAINNETS.length).toBe(30)
    expect(DEFAULT_TESTNETS.length).toBe(13)
  })
  it('every catalog mainnet is in the asset catalog', () => {
    for (const n of CATALOG_NETWORKS) expect(isCatalogChain(n.caip2), n.caip2).toBe(true)
    expect(isCatalogChain('eip155:11155111')).toBe(false)
  })
  it('chain id helpers', () => {
    expect(chainHex('eip155:8453')).toBe('0x2105')
    expect(caip2FromChainId('0x2105')).toBe('eip155:8453')
    expect(caip2FromChainId('1')).toBe('eip155:1')
    expect(caip2FromChainId(0)).toBeNull()
    expect(caip2FromChainId('abc')).toBeNull()
    expect(familyOf('bip122:00000000da84f2bafbbc53dee25a72ae')).toBe('btc')
    expect(familyOf('cosmos:cosmoshub-4')).toBeNull()
  })
  it('expected identities per family', () => {
    expect(expectedIdentity('eip155:10143')).toEqual({ family: 'evm', value: '10143' })
    expect(expectedIdentity('solana:mainnet')?.value).toBe('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
    expect(expectedIdentity('ton:-3')?.value).toBe('-3')
    expect(expectedIdentity('tron:728126428')?.value).toBe('2b6653dc')
    expect(expectedIdentity('tron:nile')?.value).toBe('cd8690dc')
    expect(expectedIdentity('tron:0xcd8690dc')?.value).toBe('cd8690dc')
    expect(expectedIdentity('bitcoin:mainnet')?.value).toBe('000000000019d6689c085ae165831e93')
    expect(expectedIdentity('bip122:00000000da84f2bafbbc53dee25a72ae')?.value).toBe('00000000da84f2bafbbc53dee25a72ae')
    expect(expectedIdentity('zcash:testnet')?.value).toBe('05a60a92d99d85997cce3b87616c089f')
    expect(expectedIdentity('near:testnet')).toEqual({ family: 'near', value: 'testnet' })
  })
})

describe('url policy', () => {
  it('parses hosts, ports and credentials without URL', () => {
    expect(parseUrl('https://rpc.example.org/v1?k=1')).toEqual({ scheme: 'https', host: 'rpc.example.org', port: null, hasCredentials: false, rest: '/v1?k=1' })
    expect(parseUrl('http://[::1]:8545')).toMatchObject({ scheme: 'http', host: '::1', port: 8545 })
    expect(parseUrl('http://user:pw@10.0.0.2:8545')).toMatchObject({ host: '10.0.0.2', hasCredentials: true })
    expect(parseUrl('rpc.example.org')).toBeNull()
    expect(parseUrl('https://host:99999')).toBeNull()
  })
  it('knows private hosts', () => {
    for (const h of ['localhost', 'node.localhost', '127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', 'geth.local', '::1', 'fd12::1', 'fe80::1']) expect(isPrivateHost(h), h).toBe(true)
    for (const h of ['172.32.0.1', '172.15.0.1', '11.0.0.1', '192.169.0.1', 'rpc.example.org', 'local.example.com', '2001:db8::1']) expect(isPrivateHost(h), h).toBe(false)
  })
  it('https anywhere, http only local and only with the opt-in', () => {
    expect(checkRpcUrl('https://rpc.example.org')).toMatchObject({ ok: true, local: false })
    expect(checkRpcUrl('http://rpc.example.org')).toMatchObject({ ok: false, reason: 'http-not-local' })
    expect(checkRpcUrl('http://localhost:8545')).toMatchObject({ ok: false, reason: 'http-not-allowed' })
    expect(checkRpcUrl('http://localhost:8545', { allowHttpLocal: true })).toMatchObject({ ok: true, local: true })
    expect(checkRpcUrl('http://192.168.1.5:8545', { allowHttpLocal: true })).toMatchObject({ ok: true, local: true })
    expect(checkRpcUrl('http://8.8.8.8:8545', { allowHttpLocal: true })).toMatchObject({ ok: false, reason: 'http-not-local' })
    expect(checkRpcUrl('ws://rpc.example.org')).toMatchObject({ ok: false, reason: 'scheme' })
    expect(checkRpcUrl('https://user:pw@rpc.example.org')).toMatchObject({ ok: false, reason: 'credentials' })
    expect(checkRpcUrl('not a url')).toMatchObject({ ok: false, reason: 'not-a-url' })
  })
})

describe('NetworksTable', () => {
  it('starts with the builtin table: listSync / getSync answer builtin-only before load, the endpoint readers refuse', async () => {
    const t = table()
    expect(t.loaded).toBe(false)
    expect(t.getSync('eip155:1')?.builtinRpcs).toEqual(['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'])
    // Audit 2026-10-25 (post-release), L7: before load these answered from the builtin table, so a
    // client built at cold start used public RPCs the user had turned off (onlyOwnRpc) and the
    // review sheet said "not a custom RPC" for a network the user had pointed at their own node.
    expect(() => t.rpcUrlsForSync('eip155:1')).toThrow(expect.objectContaining({ name: 'NetworkError', code: 'not-loaded' }))
    expect(() => t.usesUserRpcSync('eip155:1')).toThrow(/load\(\)/)
    const all = await t.list()
    expect(t.rpcUrlsForSync('eip155:1')).toEqual(['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'])
    expect(t.rpcUrlsForSync('eip155:424242')).toEqual([])
    expect(t.loaded).toBe(true)
    expect(all.length).toBe(BUILTIN_NETWORKS.length)
    expect(all.find((n) => n.caip2 === 'ton:-3')?.enabled).toBe(false)
  })
  it('prepends user RPCs to a builtin list, keeps the public fallback unless onlyOwnRpc', async () => {
    const t = table()
    await t.addRpc('eip155:8453', 'https://my.base.rpc')
    expect(await t.rpcUrlsFor('eip155:8453')).toEqual(['https://my.base.rpc', 'https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'])
    expect(await t.usesUserRpc('eip155:8453')).toBe(true)
    expect(await t.usesUserRpc('eip155:1')).toBe(false)
    await t.setOnlyOwnRpc('eip155:8453', true)
    expect(await t.rpcUrlsFor('eip155:8453')).toEqual(['https://my.base.rpc'])
    const e = await t.get('eip155:8453')
    expect(e?.userRpcs).toEqual(['https://my.base.rpc'])
    expect(e?.builtinRpcs.length).toBe(3)
    expect(e?.onlyOwnRpc).toBe(true)
    await t.removeRpc('eip155:8453', 'https://my.base.rpc')
    // onlyOwnRpc with no healthy user RPC falls back to the public list rather than nothing.
    expect(await t.rpcUrlsFor('eip155:8453')).toEqual(['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'])
    expect(await t.usesUserRpc('eip155:8453')).toBe(false)
  })
  it('refuses to delete a builtin and refuses policy-violating RPCs', async () => {
    const t = table()
    await expect(t.remove('eip155:1')).rejects.toBeInstanceOf(NetworkError)
    await expect(t.addRpc('eip155:1', 'http://rpc.example.org')).rejects.toMatchObject({ code: 'url-policy', reason: 'http-not-local' })
    await expect(t.addRpc('eip155:1', 'http://localhost:8545')).rejects.toMatchObject({ code: 'url-policy', reason: 'http-not-allowed' })
    await t.setAllowHttpLocal(true)
    await t.addRpc('eip155:1', 'http://localhost:8545')
    expect((await t.rpcUrlsFor('eip155:1'))[0]).toBe('http://localhost:8545')
    await expect(t.addRpc('eip155:424242', 'https://x')).rejects.toMatchObject({ code: 'unknown-network' })
  })
  it('custom networks: added, listed, no fallback, removable; a custom entry cannot shadow a builtin', async () => {
    const t = table()
    const n: Network = { caip2: 'eip155:31337', family: 'evm', name: 'Anvil', symbol: 'ETH', decimals: 18, kind: 'custom', rpcs: ['https://anvil.example.org'], source: 'user', enabled: true }
    await t.add(n)
    expect(await t.rpcUrlsFor('eip155:31337')).toEqual(['https://anvil.example.org'])
    expect(await t.usesUserRpc('eip155:31337')).toBe(true)
    expect((await t.get('eip155:31337'))?.kind).toBe('custom')
    await t.setRpcs('eip155:31337', ['https://anvil2.example.org', 'https://anvil.example.org'])
    expect(await t.rpcUrlsFor('eip155:31337')).toEqual(['https://anvil2.example.org', 'https://anvil.example.org'])
    await expect(t.setRpcs('eip155:31337', [])).rejects.toMatchObject({ code: 'last-rpc' })
    await t.enable('eip155:31337', false)
    expect((await t.get('eip155:31337'))?.enabled).toBe(false)
    await t.remove('eip155:31337')
    expect(await t.get('eip155:31337')).toBeNull()
    await expect(t.add({ ...n, caip2: 'eip155:1' })).rejects.toMatchObject({ code: 'builtin' })
    await expect(t.add({ ...n, caip2: 'solana:foo' })).rejects.toMatchObject({ code: 'bad-network' })
    await expect(t.add({ ...n, rpcs: [] })).rejects.toMatchObject({ code: 'bad-network' })
    const poisoned = table({ v: 1, allowHttpLocal: false, overrides: {}, custom: [{ ...n, caip2: 'eip155:1', rpcs: ['https://evil.example.org'] }], issues: {} })
    expect((await poisoned.rpcUrlsFor('eip155:1'))[0]).toBe('https://ethereum-rpc.publicnode.com')
  })
  it('persists deltas only and reloads them; a parked RPC is skipped until it passes again', async () => {
    const storage = memoryJsonStorage<NetworksState>()
    const t = new NetworksTable(storage)
    await t.addRpc('eip155:1', 'https://my.eth.rpc')
    await t.enable('eip155:11155111', true)
    await t.markRpc('eip155:1', 'https://my.eth.rpc', { ok: false, latencyMs: 10, error: 'chain-id-mismatch: Endpoint serves chain 8453, not 1.', reported: '8453' }, 1_700_000_000_000)
    expect(await t.rpcUrlsFor('eip155:1')).toEqual(['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'])
    expect(await t.usesUserRpc('eip155:1')).toBe(false)
    const again = new NetworksTable(storage)
    const e = await again.get('eip155:1')
    expect(e?.userRpcs).toEqual(['https://my.eth.rpc'])
    expect(e?.issues['https://my.eth.rpc']).toEqual({ error: 'chain-id-mismatch: Endpoint serves chain 8453, not 1.', at: 1_700_000_000_000, reported: '8453' })
    expect((await again.get('eip155:11155111'))?.enabled).toBe(true)
    expect(storage.value?.overrides['eip155:1']).toEqual({ userRpcs: ['https://my.eth.rpc'] })
    expect(storage.value?.custom).toEqual([])
    await again.markRpc('eip155:1', 'https://my.eth.rpc', { ok: true, latencyMs: 5 })
    expect((await again.rpcUrlsFor('eip155:1'))[0]).toBe('https://my.eth.rpc')
    await again.removeRpc('eip155:1', 'https://my.eth.rpc')
    expect(Object.keys((await again.get('eip155:1'))!.issues)).toEqual([])
    await again.reset()
    expect((await again.get('eip155:11155111'))?.enabled).toBe(false)
  })
  it('notifies subscribers on every write', async () => {
    const t = table()
    let n = 0
    const off = t.subscribe(() => { n++ })
    await t.setAllowHttpLocal(true)
    await t.enable('ton:-3', true)
    off()
    await t.enable('ton:-3', false)
    expect(n).toBe(2)
  })
})

describe('parseAddChainParams (EIP-3085)', () => {
  it('accepts a catalog chain with https RPCs and records the site origin', () => {
    const r = parseAddChainParams([{ chainId: '0x2105', chainName: 'Base', rpcUrls: ['http://insecure.example.org', 'https://mainnet.base.org'], nativeCurrency: { symbol: 'ETH', decimals: 18 }, blockExplorerUrls: ['https://basescan.org/'] }], { origin: 'https://app.example.org', now: () => 42 })
    expect(isAddChainError(r)).toBe(false)
    expect(r).toMatchObject({ caip2: 'eip155:8453', family: 'evm', kind: 'custom', name: 'Base', symbol: 'ETH', rpcs: ['https://mainnet.base.org'], explorer: 'https://basescan.org', source: { origin: 'https://app.example.org', addedAt: 42 }, enabled: true })
  })
  it('refuses unknown chains, bad ids, http-only lists and odd decimals', () => {
    expect(parseAddChainParams([{ chainId: '0x7a69', rpcUrls: ['https://x'] }])).toMatchObject({ code: 4902 })
    expect(parseAddChainParams([{ chainId: 'base', rpcUrls: ['https://x'] }])).toMatchObject({ code: -32602 })
    expect(parseAddChainParams([{ chainId: '0x1', rpcUrls: ['http://x.example.org'] }])).toMatchObject({ code: -32602 })
    expect(parseAddChainParams([{ chainId: '0x1', rpcUrls: ['https://x'], nativeCurrency: { symbol: 'ETH', decimals: 6 } }])).toMatchObject({ code: -32602 })
    expect(parseAddChainParams('nope')).toMatchObject({ code: -32602 })
    expect(parseAddChainParams([{ chainId: '0x7a69', rpcUrls: ['https://x'] }], { known: () => true })).toMatchObject({ caip2: 'eip155:31337', source: 'user' })
  })
})

// ---- verifyNetwork with a scripted fetch ----

type Route = (url: string, body: unknown) => unknown | string
const fake = (routes: Route, status = 200): FetchLike => async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null
  const out = routes(url, body)
  return { ok: status < 400, status, text: async () => (typeof out === 'string' ? out : JSON.stringify(out)) }
}
const rpc = (answers: Record<string, unknown>): Route => (_url, body) => {
  const b = body as { method: string } | null
  const r = b ? answers[b.method] : undefined
  return r === undefined ? { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } } : { jsonrpc: '2.0', id: 1, result: r }
}
const net = (caip2: string, family: Network['family'], rpcs: string[]) => ({ caip2, family, rpcs })
let t = 0
const clock = () => (t += 7)

describe('verifyNetwork', () => {
  it('evm: chain id must match; reports the mismatch', async () => {
    const ok = await verifyNetwork(net('eip155:8453', 'evm', ['https://x']), { fetch: fake(rpc({ eth_chainId: '0x2105', eth_blockNumber: '0x10' })), now: clock })
    expect(ok).toEqual({ ok: true, latencyMs: 7, tip: 16, reported: '8453' })
    const bad = await verifyNetwork(net('eip155:1', 'evm', ['https://x']), { fetch: fake(rpc({ eth_chainId: '0x2105' })) })
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/^chain-id-mismatch/)
    expect(bad.reported).toBe('8453')
    const noTip = await verifyNetwork(net('eip155:1', 'evm', ['https://x']), { fetch: fake(rpc({ eth_chainId: '0x1' })) })
    expect(noTip).toMatchObject({ ok: true, reported: '1' })
    expect(noTip.tip).toBeUndefined()
  })
  it('solana: genesis hash prefix; ton: global id from config 19; near: chain_id', async () => {
    expect(await verifyNetwork(net('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'solana', ['https://x']), { fetch: fake(rpc({ getGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', getSlot: 5 })) })).toMatchObject({ ok: true, tip: 5 })
    expect((await verifyNetwork(net('solana:mainnet', 'solana', ['https://x']), { fetch: fake(rpc({ getGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' })) })).error).toMatch(/^chain-id-mismatch/)
    const ton = rpc({ getMasterchainInfo: { last: { seqno: 123 } }, getConfigParam: { config: { bytes: 'te6cckEBAQEABgAACP////0sxAxZ' } } })
    expect(await verifyNetwork(net('ton:-3', 'ton', ['https://x']), { fetch: fake(ton) })).toMatchObject({ ok: true, tip: 123, reported: '-3' })
    expect((await verifyNetwork(net('ton:-239', 'ton', ['https://x']), { fetch: fake(ton) })).error).toMatch(/^chain-id-mismatch/)
    expect(await verifyNetwork(net('near:testnet', 'near', ['https://x']), { fetch: fake(rpc({ status: { chain_id: 'testnet', sync_info: { latest_block_height: 9 } } })) })).toMatchObject({ ok: true, tip: 9 })
    expect((await verifyNetwork(net('near:mainnet', 'near', ['https://x']), { fetch: fake(rpc({ status: { chain_id: 'testnet' } })) })).error).toMatch(/^chain-id-mismatch/)
  })
  it('decodes the TON global id from the config cell', () => {
    expect(tonGlobalIdFromBoc('te6cckEBAQEABgAACP////0sxAxZ')).toBe(-3)
    expect(tonGlobalIdFromBoc('te6cckEBAQEABgAACP///xEZ8G9C')).toBe(-239)
    expect(tonGlobalIdFromBoc('AAAA')).toBeNull()
  })
  it('tron: genesis block id tail', async () => {
    const tron: Route = (url) => (url.endsWith('/wallet/getnowblock') ? { block_header: { raw_data: { number: 77 } } } : { blockID: '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc' })
    expect(await verifyNetwork(net('tron:nile', 'tron', ['https://nile.example.org/']), { fetch: fake(tron) })).toMatchObject({ ok: true, tip: 77, reported: 'cd8690dc' })
    expect((await verifyNetwork(net('tron:728126428', 'tron', ['https://x']), { fetch: fake(tron) })).error).toMatch(/^chain-id-mismatch/)
  })
  it('btc / zcash: esplora, blockbook and blockchair shapes', async () => {
    const esplora: Route = (url) => (url.endsWith('/blocks/tip/height') ? '157200' : '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043')
    expect(await verifyNetwork(net('bip122:00000000da84f2bafbbc53dee25a72ae', 'btc', ['https://mempool.example/testnet4/api']), { fetch: fake(esplora) })).toMatchObject({ ok: true, tip: 157200 })
    expect((await verifyNetwork(net('bitcoin:mainnet', 'btc', ['https://mempool.example/testnet4/api']), { fetch: fake(esplora) })).error).toMatch(/^chain-id-mismatch/)
    const blockbook: Route = (url) => (url.endsWith('/api/v2') ? { blockbook: { bestHeight: 42 }, backend: { chain: 'main' } } : url.endsWith('/block-index/0') ? { blockHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f' } : 'not found')
    expect(await verifyNetwork(net('bitcoin:mainnet', 'btc', ['https://bb.example']), { fetch: fake(blockbook) })).toMatchObject({ ok: true, tip: 42 })
    const blockchair: Route = (url) => (url.endsWith('/stats') ? { data: { blocks: 3525483 } } : { data: [{ block: { hash: '00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08' } }] })
    expect(await verifyNetwork(net('zcash:mainnet', 'zcash', ['https://api.blockchair.com/zcash']), { fetch: fake(blockchair) })).toMatchObject({ ok: true, tip: 3525483 })
    expect((await verifyNetwork(net('zcash:testnet', 'zcash', ['https://api.blockchair.com/zcash']), { fetch: fake(blockchair) })).error).toMatch(/^chain-id-mismatch/)
  })
  it('policy, http errors, bad json, timeouts and missing endpoints never throw', async () => {
    expect((await verifyNetwork(net('eip155:1', 'evm', []), {})).error).toMatch(/^no-rpc/)
    expect((await verifyNetwork(net('eip155:1', 'evm', ['http://rpc.example.org']), { fetch: fake(rpc({})) })).error).toMatch(/^url-policy/)
    expect((await verifyNetwork(net('eip155:1', 'evm', ['http://localhost:8545']), { fetch: fake(rpc({ eth_chainId: '0x1' })), allowHttpLocal: true })).ok).toBe(true)
    expect((await verifyNetwork(net('eip155:1', 'evm', ['https://x']), { fetch: fake(rpc({}), 429) })).error).toMatch(/^http-429/)
    expect((await verifyNetwork(net('eip155:1', 'evm', ['https://x']), { fetch: fake(() => '<html>') })).error).toMatch(/^bad-json/)
    expect((await verifyNetwork(net('eip155:1', 'evm', ['https://x']), { fetch: fake(rpc({})) })).error).toMatch(/^rpc-error: eth_chainId/)
    expect((await verifyNetwork(net('eip155:1', 'evm', ['https://x']), { fetch: async () => { throw new Error('ECONNREFUSED') } })).error).toMatch(/^unreachable: ECONNREFUSED/)
    const slow: FetchLike = () => new Promise(() => {})
    expect((await verifyNetwork(net('eip155:1', 'evm', ['https://x']), { fetch: slow, timeoutMs: 20 })).error).toMatch(/^timeout/)
    expect((await verifyNetwork({ caip2: 'cosmos:cosmoshub-4', family: 'evm', rpcs: ['https://x'] }, { fetch: fake(rpc({})) })).error).toMatch(/^bad-network/)
  })
  it('verifyRpcs checks every endpoint on its own', async () => {
    const r = await verifyRpcs(net('eip155:1', 'evm', ['https://a', 'https://b']), { fetch: fake((url) => ({ jsonrpc: '2.0', id: 1, result: url === 'https://a' ? '0x1' : '0x2' })) })
    expect(r.map((x) => [x.rpc, x.result.ok])).toEqual([['https://a', true], ['https://b', false]])
  })
})
