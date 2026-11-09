/**
 * Extension audit 2026-11-09.
 * E15 (owner decision: per-site grants): an origin sees only the accounts it was
 * granted that are also the wallet's active account; connecting another account
 * ADDS it to that origin's grant; a signature names a granted AND active account
 * or is refused with a clear message.
 * E19: `eth_getLogs` from an origin without an EVM grant is bounded to a block span.
 */
import { describe, expect, it, vi } from 'vitest'
import { ApprovalQueue, GETLOGS_MAX_SPAN_UNCONNECTED, NetworksTable, PermissionStore, RequestRouter, memoryApprovalWindow, memoryJsonStorage, toRelayError, type EvmNetwork, type PermissionsState } from '../src/index.js'


const A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const B = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'
const SITE = 'https://app.example'
const OTHER = 'https://other.example'
const flush = () => new Promise((r) => setTimeout(r, 0))
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => toRelayError(e))

function harness() {
  const permissions = new PermissionStore(memoryJsonStorage<PermissionsState>())
  const window = memoryApprovalWindow()
  let seq = 0
  const approvals = new ApprovalQueue(window, () => `req-${++seq}`)
  const active = { evm: A }
  const events: Array<[string, string, unknown]> = []
  const rpc = vi.fn(async (_n: EvmNetwork, method: string, params: unknown[]) => (method === 'eth_blockNumber' ? '0x1000000' : { method, params }))
  const sign = vi.fn(async () => '0xsigned')
  const router = new RequestRouter({ permissions, networks: new NetworksTable(memoryJsonStorage<EvmNetwork[]>()), approvals, rpc, sign, accounts: async () => [active.evm], emit: (o, e, d) => events.push([o, e, d]) })
  const call = (method: string, params?: unknown, origin = SITE) => router.handle(origin, 'eip155', method, params)
  const connect = async (origin = SITE) => { const p = call('eth_requestAccounts', undefined, origin); await flush(); approvals.resolve(window.opened.at(-1)!.id, [active.evm]); return p }
  return { permissions, window, approvals, active, events, rpc, sign, router, call, connect }
}

describe('per-site EVM grants (audit E15)', () => {
  it('switching to a non-granted account: the site sees [], connect opens a sheet and ADDS the account; switching back restores the old one', async () => {
    const h = harness()
    expect(await h.connect()).toEqual([A])
    h.active.evm = B
    expect(await h.call('eth_accounts')).toEqual([])
    expect(await h.call('wallet_getPermissions')).toEqual([])
    expect(await h.connect()).toEqual([B])
    expect(h.window.opened).toHaveLength(2) // a real sheet for B
    expect((await h.permissions.get(SITE))!.accounts).toEqual([B, A]) // added, not replaced
    expect(await h.call('eth_accounts')).toEqual([B])
    h.active.evm = A
    expect(await h.call('eth_accounts')).toEqual([A]) // still granted, no new sheet
    expect(await h.call('eth_requestAccounts')).toEqual([A])
    expect(h.window.opened).toHaveLength(2)
    // another origin never saw B
    expect(await h.connect(OTHER)).toEqual([A])
    h.active.evm = B
    expect(await h.call('eth_accounts', undefined, OTHER)).toEqual([])
    expect((await h.permissions.get(OTHER))!.accounts).toEqual([A])
  })

  it('a signature for a granted account that is not the active one is refused with a clear message; the review hook only gets the visible accounts', async () => {
    const h = harness()
    await h.connect()
    h.active.evm = B
    const refused = await failure(h.call('eth_sendTransaction', [{ from: A, to: B }]))
    expect(refused).toMatchObject({ code: 4100, message: expect.stringMatching(/not the wallet's active account|switch/i) })
    expect(h.sign).not.toHaveBeenCalled()
    // grant B too: now the hook runs, with only the active account
    await h.connect()
    expect(await h.call('personal_sign', ['0x68656c6c6f', B])).toBe('0xsigned')
    expect(h.sign).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: [B] }))
  })

  it('setAccountsEverywhere is no longer needed by the router: eth_accounts never shows an account the origin was not granted', async () => {
    const h = harness()
    await h.permissions.connect('wc:' + 'ab'.repeat(32), [A], 'eip155:1')
    h.active.evm = B
    expect(await h.call('eth_accounts', undefined, 'wc:' + 'ab'.repeat(32))).toEqual([])
    expect((await h.permissions.get('wc:' + 'ab'.repeat(32)))!.accounts).toEqual([A])
  })
})

describe('eth_getLogs span for origins without an EVM grant (audit E19)', () => {
  it(`unconnected: at most ${GETLOGS_MAX_SPAN_UNCONNECTED} blocks (tags resolved against eth_blockNumber); a block hash is fine; connected: passed through`, async () => {
    const h = harness()
    const span = (from: string, to: string) => [{ fromBlock: from, toBlock: to, address: A }]
    expect(await failure(h.call('eth_getLogs', span('0x0', '0x100000')))).toMatchObject({ code: -32005 })
    expect(await failure(h.call('eth_getLogs', span('earliest', 'latest')))).toMatchObject({ code: -32005 })
    expect(await failure(h.call('eth_getLogs', [{ fromBlock: '0x0' }]))).toMatchObject({ code: -32005 }) // toBlock defaults to latest
    expect(await failure(h.call('eth_getLogs', span('0x10', '0x5')))).toBeNull() // empty range is the node's business
    expect(await h.call('eth_getLogs', span(`0x${(0x1000000 - GETLOGS_MAX_SPAN_UNCONNECTED).toString(16)}`, 'latest'))).toMatchObject({ method: 'eth_getLogs' })
    expect(await h.call('eth_getLogs', [{}])).toMatchObject({ method: 'eth_getLogs' }) // latest..latest
    expect(await h.call('eth_getLogs', [{ blockHash: '0x' + '11'.repeat(32) }])).toMatchObject({ method: 'eth_getLogs' })
    expect(await failure(h.call('eth_getLogs', [{ fromBlock: 'nonsense' }]))).toMatchObject({ code: -32602 })
    await h.connect()
    expect(await h.call('eth_getLogs', span('0x0', '0x100000'))).toMatchObject({ method: 'eth_getLogs' })
  })
})
