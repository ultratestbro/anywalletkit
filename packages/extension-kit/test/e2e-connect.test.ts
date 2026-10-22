/**
 * End to end over the three hops with the in-memory adapters: a fake page
 * provider built from the relay types → a fake content script (stampOrigin) →
 * the worker side (checkSenderOrigin → RequestRouter) → responses and events
 * back to the page. The approval window is the in-memory one; the wallet is a
 * real Keyring over the Vault/Session.
 */
import { describe, expect, it } from 'vitest'
import { Keyring } from '@forgewallet/keyring'
import { WalletManagerEvm } from '@forgewallet/wallet-evm'
import {
  ApprovalQueue,
  NetworksTable,
  PAGE_TARGET,
  PermissionStore,
  RequestRouter,
  Session,
  Vault,
  checkSenderOrigin,
  chromeKeyringStorage,
  isPageEvent,
  isPageRequest,
  isPageResponse,
  isRelayRequest,
  isRelayToContent,
  memoryAlarms,
  memoryApprovalWindow,
  memoryJsonStorage,
  memorySessionStorage,
  memoryVaultStorage,
  newRequestId,
  stampOrigin,
  toRelayError,
  vaultSecretStorage,
  type EvmNetwork,
  type PageEvent,
  type PageRequest,
  type PageResponse,
  type PermissionsState,
  type RelayEvent,
  type RelayResponse,
  type StorageAreaLike,
} from '../src/index.js'

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ABANDON_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const ORIGIN = 'https://dapp.example'
const flush = () => new Promise((r) => setTimeout(r, 0))

function memoryArea(): StorageAreaLike {
  const items = new Map<string, unknown>()
  return {
    async get(keys) { const out: Record<string, unknown> = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (items.has(k)) out[k] = structuredClone(items.get(k)); return out },
    async set(o) { for (const [k, v] of Object.entries(o)) items.set(k, structuredClone(v)) },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) items.delete(k) },
  }
}

/** The page side: what `src/injected` does, over an in-process "window". */
function fakePage(post: (m: PageRequest) => void) {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const events: Array<[string, unknown]> = []
  return {
    events,
    request(method: string, params?: unknown) {
      return new Promise((resolve, reject) => {
        const id = newRequestId()
        pending.set(id, { resolve, reject })
        post(params === undefined ? { target: PAGE_TARGET.toContent, id, chain: 'eip155', method } : { target: PAGE_TARGET.toContent, id, chain: 'eip155', method, params })
      })
    },
    receive(msg: unknown) {
      if (isPageResponse(msg)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }))
        else p.resolve(msg.result)
      } else if (isPageEvent(msg)) events.push([msg.event, msg.data])
    },
  }
}

describe('eth_requestAccounts end to end', () => {
  it('page → content → worker → approval window → events back to the page', async () => {
    // wallet
    const vault = new Vault({ storage: memoryVaultStorage() })
    const session = new Session({ storage: memorySessionStorage(), alarms: memoryAlarms() })
    await session.unlock(await vault.create('pw-pw-pw-pw'))
    const keyring = await Keyring.load({ storage: chromeKeyringStorage(memoryArea()), secrets: vaultSecretStorage(vault, session), chains: { evm: { Manager: WalletManagerEvm, config: {} } } })
    await keyring.importMnemonic(ABANDON)

    // worker
    const permissions = new PermissionStore(memoryJsonStorage<PermissionsState>())
    const networks = new NetworksTable(memoryJsonStorage<EvmNetwork[]>())
    const window = memoryApprovalWindow()
    const approvals = new ApprovalQueue(window)
    const toContent: unknown[] = []
    const router = new RequestRouter({
      permissions, networks, approvals,
      accounts: async () => ((await session.isUnlocked()) && keyring.activeAccount?.addresses.evm ? [keyring.activeAccount.addresses.evm] : []),
      rpc: async (network, method) => ({ network: network.caip2, method }),
      emit: (origin, event, data) => { if (origin === ORIGIN) toContent.push({ kind: 'event', chain: 'eip155', event, data } satisfies RelayEvent) },
    })
    const sender = { origin: ORIGIN, tab: { id: 7 } }
    const workerReceive = async (msg: unknown) => {
      if (!isRelayRequest(msg)) return
      const origin = checkSenderOrigin(sender, msg.origin)
      if (!origin) return
      let response: RelayResponse
      try { response = { kind: 'response', id: msg.id, result: (await router.handle(origin, msg.chain, msg.method, msg.params)) ?? null } } catch (e) { response = { kind: 'response', id: msg.id, error: toRelayError(e) } }
      toContent.push(response)
    }

    // content script: page messages get the origin stamped; worker messages go back as page messages
    const page = fakePage((m) => { if (isPageRequest(m)) void workerReceive(stampOrigin(m, ORIGIN)) })
    const pump = () => { for (const m of toContent.splice(0)) if (isRelayToContent(m)) page.receive(m.kind === 'response' ? ({ target: PAGE_TARGET.toPage, id: m.id, ...('result' in m ? { result: m.result } : {}), ...(m.error ? { error: m.error } : {}) } satisfies PageResponse) : ({ target: PAGE_TARGET.toPage, chain: m.chain, event: m.event, data: m.data } satisfies PageEvent)) }

    // before connecting
    const chainId = page.request('eth_chainId'); await flush(); pump()
    expect(await chainId).toBe('0x1')
    const none = page.request('eth_accounts'); await flush(); pump()
    expect(await none).toEqual([])

    // decline first
    const declined = page.request('eth_requestAccounts')
    await flush()
    expect(window.opened).toHaveLength(1)
    expect(window.opened[0]).toMatchObject({ origin: ORIGIN, kind: 'connect', payload: { accounts: [ABANDON_0] } })
    approvals.decline(window.opened[0]!.id)
    await flush(); pump()
    await expect(declined).rejects.toMatchObject({ code: 4001 })
    expect(page.events).toEqual([])

    // approve
    const approved = page.request('eth_requestAccounts')
    await flush()
    approvals.resolve(window.opened[1]!.id, [ABANDON_0])
    await flush(); pump()
    expect(await approved).toEqual([ABANDON_0])
    expect(page.events).toEqual([['connect', { chainId: '0x1' }], ['accountsChanged', [ABANDON_0]]])

    // a forged origin from the page is dropped before the router, nothing comes back
    void workerReceive({ kind: 'request', id: 'forged', origin: 'https://other.example', chain: 'eip155', method: 'eth_accounts' })
    await flush()
    expect(toContent).toEqual([])

    // locked wallet: eth_accounts is [] and the next eth_requestAccounts re-prompts (the window unlocks first)
    await session.lock()
    const locked = page.request('eth_accounts'); await flush(); pump()
    expect(await locked).toEqual([])
    const again = page.request('eth_requestAccounts')
    await flush()
    expect(window.opened).toHaveLength(3)
    expect(window.opened[2]!.payload).toEqual({ accounts: [] })
    await session.unlock(await vault.unlock('pw-pw-pw-pw'))
    approvals.resolve(window.opened[2]!.id, [ABANDON_0])
    await flush(); pump()
    expect(await again).toEqual([ABANDON_0])

    // chain switch reaches the page as chainChanged
    const sw = page.request('wallet_switchEthereumChain', [{ chainId: '0x2105' }])
    await flush()
    approvals.resolve(window.opened[3]!.id, null)
    await flush(); pump()
    expect(await sw).toBeNull()
    expect(page.events.at(-1)).toEqual(['chainChanged', '0x2105'])
    const read = page.request('eth_blockNumber', []); await flush(); pump()
    expect(await read).toEqual({ network: 'eip155:8453', method: 'eth_blockNumber' })

    // disconnect from the wallet side
    await router.disconnect(ORIGIN); pump()
    expect(page.events.slice(-2)).toEqual([['accountsChanged', []], ['disconnect', { code: 4900, message: expect.any(String) }]])
  })
})
