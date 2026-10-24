import { describe, expect, it } from 'vitest'
import { recoverMessageAddress } from 'viem'
import { derivationVectors } from '@anywalletkit/conformance'
import { KEYRING_STORAGE_KEY, PAGE_TARGET, VAULT_STORAGE_KEY, VaultError, isPageEvent, isPageResponse, newRequestId, type AlarmsLike, type StorageAreaLike } from '@anywalletkit/extension-kit'
import {
  addPasskey, createRouter, createWallet, onPort, openWallet, popupApprovalWindow, startContentScript, unlockWithPasskey, unlockWithPassword,
  type ChromeLike, type PortLike, type WindowsLike,
} from '../src/extension.ts'

const PHRASE = derivationVectors.seeds['bip39-abandon-12']!
const ADDRESS = derivationVectors.vectors.evm['bip39-abandon-12']!.accounts[0]!.address
const SITE = 'https://dapp.example'
const PASSWORD = 'correct horse battery'
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) }

function memoryArea(): StorageAreaLike {
  const items = new Map<string, unknown>()
  return {
    async get(keys) { const out: Record<string, unknown> = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (items.has(k)) out[k] = structuredClone(items.get(k)); return out },
    async set(o) { for (const [k, v] of Object.entries(o)) items.set(k, structuredClone(v)) },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) items.delete(k) },
  }
}
function fakeChrome(): ChromeLike & { fireAlarm(name: string): void; alarmNames(): string[] } {
  const listeners: Array<(a: { name: string }) => void> = []
  const scheduled = new Map<string, number>()
  const alarms: AlarmsLike = {
    create: (name, info) => { scheduled.set(name, info.when) },
    clear: (name) => scheduled.delete(name),
    onAlarm: { addListener: (cb) => { listeners.push(cb) } },
  }
  return { storage: { local: memoryArea(), session: memoryArea() }, alarms, fireAlarm: (name) => { for (const l of listeners) l({ name }) }, alarmNames: () => [...scheduled.keys()] }
}
function fakeWindows(): WindowsLike & { open: Map<number, string>; userClose(id: number): void } {
  const open = new Map<number, string>()
  const removed: Array<(id: number) => void> = []
  let next = 100
  return {
    open,
    async create({ url }) { const id = next++; open.set(id, url); return { id } },
    async remove(id) { open.delete(id) },
    onRemoved: { addListener: (cb) => { removed.push(cb) } },
    userClose(id) { open.delete(id); for (const cb of removed) cb(id) },
  }
}

/** Page ⇄ content script ⇄ worker over in-process "ports"; `origin` is what the browser records. */
function connectPage(worker: ReturnType<typeof createRouter>, origin: string, claimed = origin) {
  const toPage: unknown[] = []
  const pageListeners: Array<(d: unknown) => void> = []
  const workerSide: Array<(m: unknown) => void> = []
  const contentSide: Array<(m: unknown) => void> = []
  const workerPort: PortLike = {
    name: '', sender: { origin },
    postMessage: (m) => { for (const l of contentSide) l(structuredClone(m)) },
    onMessage: { addListener: (cb) => { workerSide.push(cb) } },
    onDisconnect: { addListener: () => undefined },
  }
  startContentScript({
    origin: claimed,
    addPageListener: (cb) => { pageListeners.push(cb) },
    postToPage: (m) => { toPage.push(m) },
    connect: (name) => {
      workerPort.name = name
      onPort(worker, workerPort)
      return { postMessage: (m) => { for (const l of workerSide) l(structuredClone(m)) }, onMessage: { addListener: (cb) => { contentSide.push(cb) } } }
    },
  })
  return {
    toPage,
    send(method: string, params?: unknown) {
      const id = newRequestId()
      for (const l of pageListeners) l({ target: PAGE_TARGET.toContent, id, chain: 'eip155', method, ...(params === undefined ? {} : { params }) })
      return id
    },
    answer(id: string) { return toPage.find((m) => isPageResponse(m) && m.id === id) as { result?: unknown; error?: { code: number } } | undefined },
    events() { return toPage.filter(isPageEvent).map((e) => [e.event, e.data]) },
  }
}

async function setup() {
  const chrome = fakeChrome()
  const wallet = await openWallet(chrome)
  await createWallet(wallet, PASSWORD, PHRASE)
  const windows = fakeWindows()
  const window = popupApprovalWindow(windows, 'chrome-extension://abc/approve.html')
  const rpc = async (_n: unknown, method: string) => { if (method === 'eth_chainId') return '0x1'; throw new Error(`unexpected ${method}`) }
  const worker = createRouter(wallet, { chrome, window, rpc, phishing: { blacklist: ['evil.example'], fuzzylist: ['app.uniswap.org'], tolerance: 1 } })
  const lastRequest = () => [...window.shown.values()].at(-1)!
  return { chrome, wallet, windows, window, worker, lastRequest }
}

async function connected() {
  const s = await setup()
  const page = connectPage(s.worker, SITE)
  const id = page.send('eth_requestAccounts')
  await flush()
  s.worker.approvals.resolve(s.lastRequest().id, [ADDRESS])
  await flush()
  expect(page.answer(id)?.result).toEqual([ADDRESS])
  return { ...s, page }
}

describe('extension-kit guide', () => {
  it('onboarding: the vault holds the phrase sealed, the keyring metadata holds no secret', async () => {
    const { chrome, wallet } = await setup()
    expect(wallet.keyring.activeAccount?.addresses.evm).toBe(ADDRESS)
    const stored = JSON.stringify(await chrome.storage.local.get([KEYRING_STORAGE_KEY, VAULT_STORAGE_KEY]))
    expect(stored).toContain(ADDRESS)
    expect(stored).not.toContain('abandon')
    await expect(createWallet(wallet, PASSWORD, PHRASE)).rejects.toMatchObject({ code: 'exists' })
  })

  it('a short password is refused by the vault itself', async () => {
    const wallet = await openWallet(fakeChrome())
    await expect(createWallet(wallet, 'short', PHRASE)).rejects.toBeInstanceOf(VaultError)
  })

  it('connect: a popup opens for the site, the answer reaches the page with connect events', async () => {
    const { page, windows } = await connected()
    expect([...windows.open.values()]).toEqual([])
    expect(page.events()).toEqual([['connect', { chainId: '0x1' }], ['accountsChanged', [ADDRESS]]])
  })

  it('personal_sign: reviewed in the popup, signed by the keyring account', async () => {
    const { page, worker, lastRequest } = await connected()
    const id = page.send('personal_sign', ['0x68656c6c6f', ADDRESS])
    await flush()
    expect(lastRequest()).toMatchObject({ origin: SITE, kind: 'sign-message' })
    worker.approvals.resolve(lastRequest().id, null)
    await flush()
    const signature = page.answer(id)?.result as `0x${string}`
    expect(await recoverMessageAddress({ message: 'hello', signature })).toBe(ADDRESS)
  })

  it('closing the popup declines; locking declines every waiting request', async () => {
    const { page, windows, wallet } = await connected()
    const first = page.send('personal_sign', ['0x68656c6c6f', ADDRESS])
    await flush()
    windows.userClose([...windows.open.keys()][0]!)
    await flush()
    expect(page.answer(first)?.error?.code).toBe(4001)

    const second = page.send('personal_sign', ['0x68656c6c6f', ADDRESS])
    await flush()
    await wallet.session.lock()
    await flush()
    expect(page.answer(second)?.error?.code).toBe(4001)
    const accounts = page.send('eth_accounts')
    await flush()
    expect(page.answer(accounts)?.result).toEqual([])
  })

  it('a page that claims another origin gets no answer at all', async () => {
    const { worker } = await setup()
    const page = connectPage(worker, SITE, 'https://other.example')
    page.send('eth_chainId')
    await flush()
    expect(page.toPage).toEqual([])
  })

  it('phishing warnings ride along with the approval request', async () => {
    const { worker, lastRequest } = await setup()
    const page = connectPage(worker, 'https://app.uniswep.org')
    page.send('eth_requestAccounts')
    await flush()
    expect(lastRequest().originWarnings).toEqual(['The address looks like app.uniswap.org but is not that site.'])
  })

  it('auto-lock: the alarm locks the session', async () => {
    const { chrome, wallet } = await setup()
    expect(await wallet.session.isUnlocked()).toBe(true)
    const [alarm] = chrome.alarmNames()
    chrome.fireAlarm(alarm!)
    await flush()
    expect(await wallet.session.isUnlocked()).toBe(false)
  })

  it('unlock: password, wrong password, passkey (PRF)', async () => {
    const { wallet } = await setup()
    await wallet.session.lock()
    await expect(unlockWithPassword(wallet, 'not the password')).rejects.toMatchObject({ code: 'wrong-password' })
    await unlockWithPassword(wallet, PASSWORD)
    expect(await wallet.session.isUnlocked()).toBe(true)

    const prf = crypto.getRandomValues(new Uint8Array(32))
    await addPasskey(wallet, PASSWORD, { id: 'cred-1', prf: prf.slice(), label: 'MacBook Touch ID' })
    await wallet.session.lock()
    await expect(unlockWithPasskey(wallet, 'cred-1', crypto.getRandomValues(new Uint8Array(32)))).rejects.toBeInstanceOf(VaultError)
    await unlockWithPasskey(wallet, 'cred-1', prf)
    expect(prf.every((b) => b === 0)).toBe(true) // zeroized by the vault
    expect(await wallet.session.isUnlocked()).toBe(true)
  })
})
