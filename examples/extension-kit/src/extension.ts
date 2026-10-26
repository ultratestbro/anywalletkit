// The "Extension kit" guide on docs.anywallet.tech renders the #region blocks of this file.
// No @types/chrome: the kit's adapters take structural objects, so the tests pass in-memory fakes.

// #region imports
import {
  ApprovalQueue, NetworksTable, PAGE_TARGET, PORT_NAME, PermissionStore, PhishingDetector, RequestRouter, Session, Vault,
  checkSenderOrigin, chromeAlarms, chromeJsonStorage, chromeKeyringStorage, chromeLocalVaultStorage,
  chromeSessionStorage, createSignHandler, isRelayRequest, isRelayToContent, pageRequestFrom, stampOrigin,
  toRelayError, vaultSecretStorage,
  type AlarmsLike, type ApprovalRequest, type PageMessageEvent, type PageWindow, type ApprovalWindow, type EvmNetwork, type EvmSigner, type PermissionsState,
  type PortSender, type RelayResponse, type RelayToContent, type StorageAreaLike,
} from '@anywalletkit/extension-kit'
import { Keyring } from '@anywalletkit/keyring'
import { WalletManagerEvm, type WalletAccountEvm } from '@anywalletkit/wallet-evm'
// #endregion imports

/** The parts of `chrome` the service worker uses. The real `chrome` object fits these shapes. */
export interface ChromeLike {
  storage: { local: StorageAreaLike; session: StorageAreaLike }
  alarms: AlarmsLike
}

// #region open
/** Service worker start-up. The worker can be stopped at any time; everything lives in storage. */
export async function openWallet(chrome: ChromeLike) {
  const vault = new Vault({ storage: chromeLocalVaultStorage(chrome.storage.local) })
  const session = new Session({
    storage: chromeSessionStorage(chrome.storage.session), // memory-only, cleared when the browser quits
    alarms: chromeAlarms(chrome.alarms), // locks on time even if the worker was asleep
  })
  const keyring = await Keyring.load({
    storage: chromeKeyringStorage(chrome.storage.local), // names, addresses: no secrets
    secrets: vaultSecretStorage(vault, session), // every secret read goes through the unlocked vault
    chains: { evm: { Manager: WalletManagerEvm, config: {} } },
  })
  return { vault, session, keyring }
}
export type WalletParts = Awaited<ReturnType<typeof openWallet>>
// #endregion open

// #region onboarding
/** First run: create the vault, unlock the session, import the phrase. */
export async function createWallet({ vault, session, keyring }: WalletParts, password: string, phrase: string) {
  const dek = await vault.create(password) // refuses if a vault exists or the password is under 8 characters
  await session.unlock(dek) // keeps the key in session storage and zeroizes `dek`
  return keyring.importMnemonic(phrase) // sealed in the vault, never in plain storage
}
// #endregion onboarding

// #region unlock
export async function unlockWithPassword({ vault, session }: WalletParts, password: string) {
  await session.unlock(await vault.unlock(password)) // VaultError 'wrong-password' on a bad password
}

/**
 * Passkey unlock. Your extension page runs navigator.credentials.get() with the WebAuthn PRF
 * extension and passes the 32-byte PRF output here; the vault zeroizes it after use.
 * The password stays the recovery path.
 */
export async function addPasskey({ vault }: WalletParts, password: string, passkey: { id: string; prf: Uint8Array; label: string }) {
  const dek = await vault.unlock(password) // the user confirms with the password once
  try {
    await vault.addPasskey(dek, passkey)
  } finally {
    dek.fill(0)
  }
}
export async function unlockWithPasskey({ vault, session }: WalletParts, id: string, prf: Uint8Array) {
  await session.unlock(await vault.unlockWithPasskey(id, prf))
}
// #endregion unlock

/** The parts of `chrome.windows` the approval window uses. */
export interface WindowsLike {
  create(options: { url: string; type: 'popup'; width: number; height: number }): Promise<{ id?: number | undefined }>
  remove(windowId: number): Promise<void>
  onRemoved: { addListener(callback: (windowId: number) => void): void }
}

// #region approval-window
/** One popup per request. Your approval page reads the request by id and answers through the queue. */
export function popupApprovalWindow(windows: WindowsLike, pageUrl: string): ApprovalWindow & { shown: Map<string, ApprovalRequest> } {
  const byWindow = new Map<number, string>()
  const shown = new Map<string, ApprovalRequest>()
  const closed: Array<(requestId: string) => void> = []
  windows.onRemoved.addListener((windowId) => {
    const requestId = byWindow.get(windowId)
    if (requestId === undefined) return
    byWindow.delete(windowId)
    shown.delete(requestId)
    for (const handler of closed) handler(requestId) // closing the popup declines the request
  })
  return {
    shown,
    async open(request) {
      shown.set(request.id, request)
      const win = await windows.create({ url: `${pageUrl}?request=${encodeURIComponent(request.id)}`, type: 'popup', width: 380, height: 640 })
      if (win.id !== undefined) byWindow.set(win.id, request.id)
    },
    async close(requestId) {
      shown.delete(requestId)
      for (const [windowId, id] of byWindow) if (id === requestId) { byWindow.delete(windowId); await windows.remove(windowId) }
    },
    onClosed(handler) { closed.push(handler) },
  }
}
// #endregion approval-window

export interface WorkerOptions {
  chrome: ChromeLike
  window: ApprovalWindow
  /** Your RPC transport: send `method` to one of `network.rpcUrls`. */
  rpc(network: EvmNetwork, method: string, params: unknown[]): Promise<unknown>
  /** Phishing list you ship inside the build (eth-phishing-detect format). Never fetched at runtime. */
  phishing: ConstructorParameters<typeof PhishingDetector>[0]
}

// #region router
/** Everything a dApp can ask for goes through this router. */
export function createRouter(wallet: WalletParts, options: WorkerOptions) {
  const { keyring, session } = wallet
  const local = options.chrome.storage.local
  const phishing = new PhishingDetector(options.phishing)
  // A site on the shipped phishing list is refused (4100) before any window opens; lookalikes and
  // punycode only add warnings to the sheet.
  const approvals = new ApprovalQueue(options.window, undefined, { annotate: (origin) => phishing.check(origin).warnings, refuse: (origin) => phishing.refusal(origin) })
  const ports = new Map<string, Set<(message: RelayToContent) => void>>()

  // Signing: the account lives only for one signature, then its key is wiped.
  const signerFor = async (address: string) => {
    const meta = keyring.listAccounts().find((a) => a.addresses.evm?.toLowerCase() === address.toLowerCase())
    if (!meta) throw new Error('This address is not in the wallet.')
    const handle = await keyring.getAccount<WalletAccountEvm>(meta.id, 'evm')
    const signer: EvmSigner = {
      signMessage: (m) => handle.account.sign(m),
      signTypedData: (t) => handle.account.signTypedData(t),
      signTransaction: (tx) => handle.account.signTransaction(tx),
    }
    return { signer, dispose: () => handle.dispose() }
  }

  const router = new RequestRouter({
    permissions: new PermissionStore(chromeJsonStorage<PermissionsState>(local, 'my-wallet.permissions')),
    networks: new NetworksTable(chromeJsonStorage<EvmNetwork[]>(local, 'my-wallet.networks')),
    approvals,
    refuse: (origin) => phishing.refusal(origin), // reads and an earlier permission included
    // A locked wallet shows no accounts; eth_requestAccounts then opens the window to unlock.
    accounts: async () => {
      const address = keyring.activeAccount?.addresses.evm
      return (await session.isUnlocked()) && address ? [address] : []
    },
    rpc: options.rpc, // reads go to your RPC, never to the site's
    emit: (origin, event, data) => { for (const post of ports.get(origin) ?? []) post({ kind: 'event', chain: 'eip155', event, data }) },
    sign: createSignHandler({ approvals, rpc: options.rpc, signerFor }),
  })

  // Locking the wallet answers every waiting request with "declined".
  session.onLock(() => approvals.declineAll())

  return { router, approvals, ports }
}
export type WorkerParts = ReturnType<typeof createRouter>
// #endregion router

/** The parts of a `chrome.runtime.Port` the worker uses. */
export interface PortLike {
  name: string
  sender?: PortSender | undefined
  postMessage(message: unknown): void
  onMessage: { addListener(callback: (message: unknown) => void): void }
  onDisconnect: { addListener(callback: () => void): void }
}

// #region port
/** chrome.runtime.onConnect.addListener((port) => onPort(worker, port)) */
export function onPort({ router, ports }: WorkerParts, port: PortLike) {
  if (port.name !== PORT_NAME) return
  let origin: string | null = null
  const post = (message: RelayToContent) => port.postMessage(message)
  port.onMessage.addListener(async (message) => {
    if (!isRelayRequest(message)) return
    // The origin the browser recorded for this port, not the one the page claims.
    const trusted = checkSenderOrigin(port.sender, message.origin)
    if (!trusted) return // forged: dropped, never answered
    if (origin === null) {
      origin = trusted
      if (!ports.has(origin)) ports.set(origin, new Set())
      ports.get(origin)!.add(post)
    }
    let response: RelayResponse
    try {
      response = { kind: 'response', id: message.id, result: (await router.handle(trusted, message.chain, message.method, message.params)) ?? null }
    } catch (e) {
      // The page gets the EIP-1193 code and a URL-free message; anything internal is
      // "Internal error" there, and the details stay in the extension's own log.
      response = { kind: 'response', id: message.id, error: toRelayError(e, { log: (err) => console.error('[wallet] request failed', err) }) }
    }
    post(response)
  })
  port.onDisconnect.addListener(() => { if (origin) ports.get(origin)?.delete(post) })
}
// #endregion port

/** The parts of the content script's world it uses. */
export interface ContentLike {
  /** The page window (`window`); its origin is the one stamped. */
  page: PageWindow
  /** `window.addEventListener('message', …)`: the whole event, so its source and origin can be checked. */
  addPageListener(callback: (event: PageMessageEvent) => void): void
  postToPage(message: unknown): void
  connect(name: string): Pick<PortLike, 'postMessage' | 'onMessage'>
}

// #region content
/** Content script: stamps the page's origin and forwards both ways. It holds no wallet logic. */
export function startContentScript(env: ContentLike) {
  const port = env.connect(PORT_NAME)
  env.addPageListener((event) => {
    // Only what the page itself posted: an iframe's parent.postMessage is not the site speaking.
    const request = pageRequestFrom(event, env.page)
    if (request) port.postMessage(stampOrigin(request, env.page.location.origin))
  })
  port.onMessage.addListener((message) => {
    if (!isRelayToContent(message)) return
    if (message.kind === 'response') {
      env.postToPage({ target: PAGE_TARGET.toPage, id: message.id, ...('result' in message ? { result: message.result } : {}), ...(message.error ? { error: message.error } : {}) })
    } else {
      env.postToPage({ target: PAGE_TARGET.toPage, chain: message.chain, event: message.event, data: message.data })
    }
  })
}
// #endregion content
