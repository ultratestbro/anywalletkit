import { describe, expect, it } from 'vitest'
import { ApprovalQueue, NetworksTable, PermissionStore, PhishingDetector, RELAY_ERRORS, RequestRouter, memoryApprovalWindow, memoryJsonStorage, toRelayError, type EvmNetwork, type PermissionsState } from '../src/index.js'

// Audit 2026-10-25 round 3, M15: a host on the shipped phishing list only got a warning line on the
// approval sheet — the window still opened, and one click connected or signed. A blocked origin is
// now refused before any window opens (EIP-1193 4100), at the queue and at the router.

const BAD = 'https://uniswap-claim.example'
const GOOD = 'https://app.uniswap.org'
const list = { blacklist: ['uniswap-claim.example'], fuzzylist: ['app.uniswap.org'] }
const flush = () => new Promise((r) => setTimeout(r, 0))
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => toRelayError(e))

describe('phishing list: a blocked origin is refused, not warned about', () => {
  it('PhishingDetector.refusal names the reason for a listed host only', () => {
    const d = new PhishingDetector(list)
    expect(d.refusal(BAD)).toMatch(/phishing list/)
    expect(d.refusal('https://sub.uniswap-claim.example')).toMatch(/phishing list/)
    expect(d.refusal(GOOD)).toBeNull()
    expect(d.refusal('https://uniswep.org')).toBeNull() // a lookalike still only warns
  })

  it('the queue refuses a blocked origin with 4100 and opens no window', async () => {
    const d = new PhishingDetector(list)
    const w = memoryApprovalWindow()
    const q = new ApprovalQueue(w, undefined, { annotate: (o) => d.check(o).warnings, refuse: (o) => d.refusal(o) })
    for (const kind of ['connect', 'sign-message', 'send-transaction', 'swap'] as const) {
      expect(await failure(q.request({ origin: BAD, chain: 'eip155:1', kind, payload: {} }))).toMatchObject({ code: RELAY_ERRORS.unauthorized })
    }
    await flush()
    expect(w.opened).toHaveLength(0)
    expect(q.pendingFor(BAD)).toBe(0)
    const ok = q.request({ origin: GOOD, chain: 'eip155:1', kind: 'connect', payload: {} })
    await flush()
    expect(w.opened).toHaveLength(1)
    q.resolve(w.opened[0]!.id, null)
    await ok
  })

  it('the router refuses every method from a blocked origin, reads and an earlier permission included', async () => {
    const d = new PhishingDetector(list)
    const w = memoryApprovalWindow()
    const approvals = new ApprovalQueue(w)
    const permissions = new PermissionStore(memoryJsonStorage<PermissionsState>())
    await permissions.connect(BAD, ['0x9858EfFD232B4033E47d90003D41EC34EcaEda94'], 'eip155:1') // connected before the list update shipped
    const calls: string[] = []
    const router = new RequestRouter({
      permissions, networks: new NetworksTable(memoryJsonStorage<EvmNetwork[]>()), approvals,
      accounts: async () => ['0x9858EfFD232B4033E47d90003D41EC34EcaEda94'],
      rpc: async (_n, method) => { calls.push(method); return '0x1' },
      emit: () => undefined,
      refuse: (o) => d.refusal(o),
    })
    for (const [method, params] of [['eth_chainId', []], ['eth_accounts', []], ['eth_requestAccounts', []], ['eth_blockNumber', []], ['personal_sign', ['0x68', '0x9858EfFD232B4033E47d90003D41EC34EcaEda94']]] as const) {
      expect(await failure(router.handle(BAD, 'eip155', method, params))).toMatchObject({ code: RELAY_ERRORS.unauthorized })
    }
    expect(calls).toEqual([])
    expect(w.opened).toHaveLength(0)
    expect(await router.handle(GOOD, 'eip155', 'eth_chainId', [])).toBe('0x1')
  })
})
