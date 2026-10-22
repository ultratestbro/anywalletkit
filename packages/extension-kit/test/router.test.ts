import { describe, expect, it, vi } from 'vitest'
import {
  ApprovalQueue,
  DEFAULT_NETWORKS,
  NetworksTable,
  PermissionStore,
  RequestRouter,
  ReviewDeclined,
  isCatalogChain,
  memoryApprovalWindow,
  memoryJsonStorage,
  parseAddChainParams,
  toRelayError,
  type EvmNetwork,
  type PermissionsState,
} from '../src/index.js'

const A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const B = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'
const SITE = 'https://app.example'

const flush = () => new Promise((r) => setTimeout(r, 0))
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => toRelayError(e))

function harness(opts: { accounts?: string[]; sign?: boolean } = {}) {
  const permissions = new PermissionStore(memoryJsonStorage<PermissionsState>())
  const networks = new NetworksTable(memoryJsonStorage<EvmNetwork[]>())
  const window = memoryApprovalWindow()
  let seq = 0
  const approvals = new ApprovalQueue(window, () => `req-${++seq}`)
  const events: Array<[string, string, unknown]> = []
  // eth_chainId answers for the network asked (the add-chain check); everything else echoes the call
  const rpc = vi.fn(async (network: EvmNetwork, method: string, params: unknown[]) => (method === 'eth_chainId' ? `0x${network.chainId.toString(16)}` : { network: network.caip2, method, params }))
  const sign = vi.fn(async () => '0xsigned')
  const router = new RequestRouter({
    permissions, networks, approvals, rpc,
    accounts: async () => opts.accounts ?? [A, B],
    emit: (origin, event, data) => events.push([origin, event, data]),
    ...(opts.sign ? { sign } : {}),
  })
  return { permissions, networks, window, approvals, events, rpc, sign, router, call: (method: string, params?: unknown, origin = SITE) => router.handle(origin, 'eip155', method, params) }
}

describe('PermissionStore', () => {
  it('persists per origin, updates accounts everywhere, notifies', async () => {
    const storage = memoryJsonStorage<PermissionsState>()
    const store = new PermissionStore(storage)
    const seen: string[] = []
    store.onChange((origin, p) => seen.push(`${origin}:${p ? p.accounts.join('+') : 'gone'}`))
    expect(await store.get(SITE)).toBeNull()
    await store.connect(SITE, [A], 'eip155:1')
    await store.connect('https://other.example', [A], 'eip155:8453')
    expect(storage.value![SITE]!.accounts).toEqual([A])
    expect(await store.setChain(SITE, 'eip155:10')).toMatchObject({ chain: 'eip155:10' })
    expect(await store.setChain('https://nope.example', 'eip155:10')).toBeNull()
    const changed = await store.setAccountsEverywhere([B])
    expect(changed.map((p) => p.origin).sort()).toEqual([SITE, 'https://other.example'].sort())
    expect(await store.setAccountsEverywhere([B])).toEqual([]) // no-op when equal
    await store.disconnect(SITE)
    expect(await store.get(SITE)).toBeNull()
    expect((await new PermissionStore(storage).list()).map((p) => p.origin)).toEqual(['https://other.example'])
    expect(seen).toEqual([`${SITE}:${A}`, `https://other.example:${A}`, `${SITE}:${A}`, `${SITE}:${B}`, `https://other.example:${B}`, `${SITE}:gone`])
    await expect(store.connect(SITE, [], 'eip155:1')).rejects.toThrow(/at least one/)
  })

  it('setAccountsEverywhere leaves origins connected only on another chain without the EVM account (scan F6/F8)', async () => {
    const storage = memoryJsonStorage<PermissionsState>()
    const store = new PermissionStore(storage)
    const others = {
      'https://sol.example': 'solanaAccounts', 'https://ton.example': 'tonAccounts', 'https://tron.example': 'tronAccounts',
      'https://btc.example': 'btcAccounts', 'https://near.example': 'nearAccounts', 'wc:abcdef0123': 'solanaAccounts',
    } as const
    for (const [origin, key] of Object.entries(others)) await store.connectChain(origin, key, ['addr'], 'eip155:1')
    await store.connect(SITE, [A], 'eip155:1')
    const changed = await store.setAccountsEverywhere([B])
    expect(changed.map((p) => p.origin)).toEqual([SITE])
    expect((await store.get(SITE))!.accounts).toEqual([B])
    for (const origin of Object.keys(others)) {
      expect((await store.get(origin))!.accounts).toEqual([])
      expect(storage.value![origin]!.accounts).toEqual([]) // persisted too, not only the cache
    }
    // a multi-chain site keeps its Solana grant and gets EVM only through its own connect
    await store.connect('https://sol.example', [A], 'eip155:1')
    expect(await store.get('https://sol.example')).toMatchObject({ accounts: [A], solanaAccounts: ['addr'] })
  })

  it('a Solana-only origin has no EVM permission: eth_accounts and wallet_getPermissions answer [] after an account switch (scan F6/F8)', async () => {
    const h = harness()
    await h.permissions.connectChain(SITE, 'solanaAccounts', ['So1ana'], 'eip155:1')
    await h.permissions.setAccountsEverywhere([A])
    expect(await h.call('eth_accounts')).toEqual([])
    expect(await h.call('wallet_getPermissions')).toEqual([])
    // eth_requestAccounts still opens the normal connect sheet
    const pending = h.call('eth_requestAccounts')
    await flush()
    expect(h.approvals.current).toMatchObject({ origin: SITE, kind: 'connect' })
    void pending.catch(() => undefined)
    h.approvals.declineAll()
  })

  it('one connected-sites list: Solana / TON accounts join an origin and leave it independently', async () => {
    const store = new PermissionStore(memoryJsonStorage<PermissionsState>())
    await store.connectChain(SITE, 'solanaAccounts', ['So1ana'], 'eip155:1')
    expect(await store.get(SITE)).toMatchObject({ accounts: [], chain: 'eip155:1', solanaAccounts: ['So1ana'] })
    await store.connect(SITE, [A], 'eip155:8453')
    expect(await store.get(SITE)).toMatchObject({ accounts: [A], chain: 'eip155:8453', solanaAccounts: ['So1ana'] })
    await store.connectChain(SITE, 'tonAccounts', ['UQ…'], 'eip155:1')
    await store.disconnectChain(SITE, 'solanaAccounts')
    expect((await store.get(SITE))!.solanaAccounts).toBeUndefined()
    await store.disconnectChain(SITE, 'accounts')
    expect(await store.get(SITE)).toMatchObject({ accounts: [], tonAccounts: ['UQ…'] })
    await store.disconnectChain(SITE, 'tonAccounts')
    expect(await store.get(SITE)).toBeNull()
  })
})

describe('ApprovalQueue', () => {
  it('shows one request at a time, in order; decline = ReviewDeclined (4001); window closed by the user declines', async () => {
    const window = memoryApprovalWindow()
    let seq = 0
    const queue = new ApprovalQueue(window, () => `r${++seq}`)
    const changes = vi.fn()
    queue.onChange(changes)
    const first = queue.request<string>({ origin: SITE, chain: 'eip155:1', kind: 'connect', payload: {} })
    const second = queue.request<string>({ origin: SITE, chain: 'eip155:1', kind: 'switch-chain', payload: {} })
    const third = queue.request<string>({ origin: SITE, chain: 'eip155:1', kind: 'add-chain', payload: {} })
    await flush()
    expect(window.opened.map((r) => r.id)).toEqual(['r1'])
    expect(queue.current?.id).toBe('r1')
    expect(queue.queued).toBe(2)
    expect(queue.resolve('nope', 1)).toBe(false)
    expect(queue.resolve('r1', 'yes')).toBe(true)
    expect(await first).toBe('yes')
    await flush()
    expect(window.opened.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(window.openIds.has('r1')).toBe(false)
    queue.decline('r2')
    const e2 = await failure(second)
    expect(e2).toEqual({ code: 4001, message: 'You declined — nothing was signed.' })
    await flush()
    expect(queue.current?.id).toBe('r3')
    window.userClose('r3')
    await expect(third).rejects.toBeInstanceOf(ReviewDeclined)
    expect(queue.current).toBeNull()
    expect(changes).toHaveBeenCalled()
  })

  it('annotates every request with the origin warnings the wallet supplies', async () => {
    const window = memoryApprovalWindow()
    const queue = new ApprovalQueue(window, () => 'r1', { annotate: (origin) => (origin.includes('uniswep') ? ['The address looks like app.uniswap.org but is not that site.'] : []) })
    const p = queue.request({ origin: 'https://app.uniswep.org', chain: 'eip155:1', kind: 'connect', payload: {} })
    await flush()
    expect(window.opened[0]!.originWarnings).toEqual(['The address looks like app.uniswap.org but is not that site.'])
    queue.resolve('r1', null)
    await p
    const clean = new ApprovalQueue(memoryApprovalWindow(), () => 'r2', { annotate: () => [] })
    void clean.request({ origin: SITE, chain: 'eip155:1', kind: 'connect', payload: {} })
    await flush()
    expect(clean.current!.originWarnings).toBeUndefined()
  })

  it('a queued (not yet shown) request can be declined; declineAll clears everything', async () => {
    const window = memoryApprovalWindow()
    let seq = 0
    const queue = new ApprovalQueue(window, () => `r${++seq}`)
    const a = queue.request({ origin: SITE, chain: 'eip155:1', kind: 'connect', payload: {} })
    const b = queue.request({ origin: SITE, chain: 'eip155:1', kind: 'sign-message', payload: {} }) // a 2nd connect would be refused (-32002)
    await flush()
    expect(queue.decline('r2')).toBe(true)
    await expect(b).rejects.toBeInstanceOf(ReviewDeclined)
    queue.declineAll()
    const ea = await failure(a)
    expect(ea).toMatchObject({ code: 4001, message: /locked/ })
    expect(window.openIds.size).toBe(0)
  })
})

describe('RequestRouter', () => {
  it('eth_chainId / eth_accounts need no permission; connect goes through the approval window once', async () => {
    const h = harness()
    expect(await h.call('eth_chainId')).toBe('0x1')
    expect(await h.call('net_version')).toBe('1')
    expect(await h.call('eth_accounts')).toEqual([])
    expect(await h.call('wallet_getPermissions')).toEqual([])

    const pending = h.call('eth_requestAccounts')
    await flush()
    expect(h.window.opened).toHaveLength(1)
    expect(h.window.opened[0]).toMatchObject({ origin: SITE, kind: 'connect', payload: { accounts: [A, B] } })
    h.approvals.resolve(h.window.opened[0]!.id, [A, 'not-ours'])
    expect(await pending).toEqual([A])
    expect(await h.permissions.get(SITE)).toMatchObject({ accounts: [A], chain: 'eip155:1' })
    expect(h.events).toEqual([[SITE, 'connect', { chainId: '0x1' }], [SITE, 'accountsChanged', [A]]])

    // already connected: no window
    expect(await h.call('eth_requestAccounts')).toEqual([A])
    expect(await h.call('eth_accounts')).toEqual([A])
    expect(h.window.opened).toHaveLength(1)
    expect(await h.call('wallet_getPermissions')).toMatchObject([{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [A] }] }])
    // another origin sees nothing
    expect(await h.call('eth_accounts', undefined, 'https://other.example')).toEqual([])

    await h.call('wallet_revokePermissions', [{ eth_accounts: {} }])
    expect(await h.call('eth_accounts')).toEqual([])
    expect(h.events.slice(2)).toEqual([[SITE, 'accountsChanged', []], [SITE, 'disconnect', { code: 4900, message: expect.any(String) }]])
  })

  it('decline → 4001; a result naming no owned account → 4001; locked wallet offers no accounts', async () => {
    const h = harness()
    const p1 = h.call('eth_requestAccounts')
    await flush()
    h.approvals.decline(h.window.opened[0]!.id)
    expect(await failure(p1)).toEqual({ code: 4001, message: 'You declined — nothing was signed.' })
    const p2 = h.call('eth_requestAccounts')
    await flush()
    h.approvals.resolve(h.window.opened[1]!.id, ['0xnotours'])
    expect(await failure(p2)).toMatchObject({ code: 4001 })
    expect(await h.permissions.get(SITE)).toBeNull()

    const locked = harness({ accounts: [] })
    const p3 = locked.call('eth_requestAccounts')
    await flush()
    expect(locked.window.opened[0]!.payload).toEqual({ accounts: [] })
    locked.approvals.resolve(locked.window.opened[0]!.id, [A])
    expect(await failure(p3)).toMatchObject({ code: 4001 })
  })

  it('switch chain: 4100 unconnected, 4902 unknown, approval then chainChanged; same chain is a no-op', async () => {
    const h = harness()
    expect(await failure(h.call('wallet_switchEthereumChain', [{ chainId: '0x2105' }]))).toMatchObject({ code: 4100 })
    const c = h.call('eth_requestAccounts'); await flush(); h.approvals.resolve(h.window.opened[0]!.id, [A]); await c
    expect(await failure(h.call('wallet_switchEthereumChain', [{ chainId: '0xdeadbeef' }]))).toMatchObject({ code: 4902 })
    expect(await failure(h.call('wallet_switchEthereumChain', [{ chainId: 'x' }]))).toMatchObject({ code: -32602 })
    expect(await h.call('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toBeNull()
    expect(h.window.opened).toHaveLength(1)
    const sw = h.call('wallet_switchEthereumChain', [{ chainId: '0x2105' }])
    await flush()
    expect(h.window.opened[1]).toMatchObject({ kind: 'switch-chain', payload: { from: { caip2: 'eip155:1' }, to: { caip2: 'eip155:8453' } } })
    h.approvals.resolve(h.window.opened[1]!.id, null)
    expect(await sw).toBeNull()
    expect(await h.call('eth_chainId')).toBe('0x2105')
    expect(h.events.at(-1)).toEqual([SITE, 'chainChanged', '0x2105'])
    // the other origin is still on Ethereum
    expect(await h.call('eth_chainId', undefined, 'https://other.example')).toBe('0x1')
  })

  it('add chain: validated against the catalog, approved, persisted, then switched when connected', async () => {
    const h = harness()
    const bad = await failure(h.call('wallet_addEthereumChain', [{ chainId: '0x7a69', chainName: 'Hardhat', rpcUrls: ['https://x.example'] }]))
    expect(bad).toMatchObject({ code: 4902 })
    expect(await failure(h.call('wallet_addEthereumChain', [{ chainId: '0x1', rpcUrls: ['http://insecure.example'] }]))).toMatchObject({ code: -32602 })
    // a shipped chain → plain switch (needs connection)
    expect(await failure(h.call('wallet_addEthereumChain', [{ chainId: '0x2105', rpcUrls: ['https://evil.example'] }]))).toMatchObject({ code: 4100 })
    expect((await h.networks.get('eip155:8453'))!.rpcs).toEqual(DEFAULT_NETWORKS.find((n) => n.caip2 === 'eip155:8453')!.rpcs) // never replaced

    // a catalog chain the table does not ship: use a shrunk defaults table to simulate
    const small = new NetworksTable(memoryJsonStorage<EvmNetwork[]>(), DEFAULT_NETWORKS.slice(0, 1))
    const h2 = { ...harness(), networks: small }
    const router = new RequestRouter({ permissions: h2.permissions, networks: small, approvals: h2.approvals, rpc: h2.rpc, accounts: async () => [A], emit: (o, e, d) => h2.events.push([o, e, d]) })
    const c = router.handle(SITE, 'eip155', 'eth_requestAccounts', undefined); await flush(); h2.approvals.resolve(h2.window.opened[0]!.id, [A]); await c
    const add = router.handle(SITE, 'eip155', 'wallet_addEthereumChain', [{ chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] }])
    await flush()
    expect(h2.window.opened[1]).toMatchObject({ kind: 'add-chain', payload: { network: { caip2: 'eip155:8453', name: 'Base', symbol: 'ETH', rpcs: ['https://mainnet.base.org'], explorer: 'https://basescan.org' } } })
    h2.approvals.resolve(h2.window.opened[1]!.id, null)
    expect(await add).toBeNull()
    expect(await small.get('eip155:8453')).toMatchObject({ name: 'Base', custom: { origin: SITE, addedAt: expect.any(Number) } })
    expect(await router.handle(SITE, 'eip155', 'eth_chainId', undefined)).toBe('0x2105')
    // an RPC that answers for another chain (a look-alike endpoint behind a real chain id) is refused after the sheet, nothing persisted
    const lying = new RequestRouter({ permissions: h2.permissions, networks: new NetworksTable(memoryJsonStorage<EvmNetwork[]>(), DEFAULT_NETWORKS.slice(0, 1)), approvals: h2.approvals, rpc: async (_n, m) => (m === 'eth_chainId' ? '0x1' : null), accounts: async () => [A], emit: () => undefined })
    const lie = lying.handle(SITE, 'eip155', 'wallet_addEthereumChain', [{ chainId: '0x2105', rpcUrls: ['https://lying.example'] }])
    await flush(); h2.approvals.resolve(h2.window.opened.at(-1)!.id, null)
    expect(await failure(lie)).toMatchObject({ code: -32602, message: expect.stringMatching(/answers chain 0x1/) })
    expect(h2.events.at(-1)).toEqual([SITE, 'chainChanged', '0x2105'])
    expect(isCatalogChain('eip155:8453')).toBe(true)
    expect(isCatalogChain('eip155:31337')).toBe(false)
    expect(parseAddChainParams({ chainId: '0x1', rpcUrls: ['https://a.example'], nativeCurrency: { decimals: 6 } })).toMatchObject({ code: -32602 })
  })

  it('read-only RPC goes to the wallet client on the origin chain; eth_sign is never offered; unknown → 4200', async () => {
    const h = harness()
    expect(await h.call('eth_blockNumber', [])).toEqual({ network: 'eip155:1', method: 'eth_blockNumber', params: [] })
    expect(await h.call('eth_getBalance', [A, 'latest'])).toMatchObject({ params: [A, 'latest'] })
    expect(await failure(h.call('eth_sign', [A, '0x00']))).toMatchObject({ code: 4200, message: /never offered/ })
    expect(await failure(h.call('eth_signTransaction', [{}]))).toMatchObject({ code: 4200 })
    expect(await failure(h.call('eth_sendRawTransaction', ['0x00']))).toMatchObject({ code: 4200 })
    expect(await failure(h.call('wallet_watchAsset', {}))).toMatchObject({ code: 4200 })
    expect(await failure(h.router.handle(SITE, 'solana', 'connect', undefined))).toMatchObject({ code: 4200 })
  })

  it('signing methods: 4200 without a review hook; 4100 unconnected; delegated with the origin accounts', async () => {
    const none = harness()
    expect(await failure(none.call('personal_sign', ['0x68656c6c6f', A]))).toMatchObject({ code: 4200 })
    const h = harness({ sign: true })
    expect(await failure(h.call('personal_sign', ['0x68656c6c6f', A]))).toMatchObject({ code: 4100 })
    const c = h.call('eth_requestAccounts'); await flush(); h.approvals.resolve(h.window.opened[0]!.id, [A]); await c
    expect(await h.call('eth_sendTransaction', [{ from: A, to: B }])).toBe('0xsigned')
    expect(h.sign).toHaveBeenCalledWith(expect.objectContaining({ origin: SITE, method: 'eth_sendTransaction', accounts: [A], network: expect.objectContaining({ caip2: 'eip155:1' }) }))
  })
})

describe('phishing: brand in a label (SDK-144 L3)', () => {
  it('flags a known name used inside a host that is not that site; the real site and its subdomains pass; short names are ignored', async () => {
    const { PhishingDetector } = await import('../src/index.js')
    const d = new PhishingDetector({ blacklist: [], fuzzylist: ['metamask.io'], extraFuzzylist: ['app.uniswap.org', 'jup.ag'], tolerance: 1 })
    expect(d.check('https://metamask.io').warnings).toEqual([])
    expect(d.check('https://portfolio.metamask.io').warnings).toEqual([])
    expect(d.check('https://metamask.io-login.com').warnings[0]).toMatch(/contains the name of metamask\.io/)
    expect(d.check('https://app-uniswap.com').warnings[0]).toMatch(/app\.uniswap\.org/) // one edit away → the lookalike line wins
    expect(d.check('https://uniswap.org.evil.net').warnings[0]).toMatch(/contains the name of app\.uniswap\.org/)
    expect(d.check('https://uniswep.org').warnings[0]).toMatch(/looks like app\.uniswap\.org/)
    expect(d.check('https://jup.ag').warnings).toEqual([])
    expect(d.check('https://jupiter-jup.ag.example').warnings).toEqual([]) // 'jup' < 5 chars: not a brand check
    expect(d.check('https://example.com').warnings).toEqual([])
  })
})
