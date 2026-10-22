/**
 * Per-origin permissions: which accounts a site may see and which chain it is
 * on. Nothing here is secret (`chrome.storage.local`, plain JSON); the origin
 * key is the one the browser recorded for the port, never the page's claim.
 */
import type { JsonStorage } from './storage.js'

export interface OriginPermission {
  origin: string
  /** EVM addresses exposed to this origin (checksummed as the keyring stores them). Empty when only another chain is connected. */
  accounts: string[]
  /** CAIP-2 chain the origin currently sees (`eth_chainId`). */
  chain: string
  /** Solana addresses exposed to this origin (Wallet Standard `standard:connect`). */
  solanaAccounts?: string[]
  /** TON addresses exposed to this origin (TON Connect). */
  tonAccounts?: string[]
  /** Tron (TIP-1193), Bitcoin (sats-connect) and NEAR (wallet-selector) addresses. */
  tronAccounts?: string[]
  btcAccounts?: string[]
  nearAccounts?: string[]
  connectedAt: number
}

export type PermissionsState = Record<string, OriginPermission>

export type ChainAccountsKey = 'solanaAccounts' | 'tonAccounts' | 'tronAccounts' | 'btcAccounts' | 'nearAccounts'
export const CHAIN_ACCOUNT_KEYS: readonly ChainAccountsKey[] = ['solanaAccounts', 'tonAccounts', 'tronAccounts', 'btcAccounts', 'nearAccounts']

export class PermissionStore {
  private _state: PermissionsState | null = null
  private _loading: Promise<PermissionsState> | null = null
  /** Every mutation runs here, one after another (scan F22): a read-modify-write never starts from a snapshot another one is about to replace. */
  private _queue: Promise<unknown> = Promise.resolve()
  private readonly _listeners = new Set<(origin: string, permission: OriginPermission | null) => void>()

  constructor(private readonly storage: JsonStorage<PermissionsState>) {}

  private async state(): Promise<PermissionsState> {
    if (this._state) return this._state
    // One load; a load that resolves after a write must not replace the newer cache.
    this._loading ??= this.storage.get().then(
      (s) => (this._state ??= s ?? {}),
      (e: unknown) => { this._loading = null; throw e },
    )
    return this._loading
  }

  /**
   * Run `fn` after every earlier mutation settled. Public mutators wrap their WHOLE read-modify-write
   * in this; `write` itself is unlocked (setAccountsEverywhere calls it in a loop — a lock there too
   * would deadlock). Nothing awaited inside may wait on the user: routers await the approval sheet
   * first and only then call the store.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._queue.then(fn, fn)
    this._queue = run.then(() => undefined, () => undefined)
    return run
  }

  async get(origin: string): Promise<OriginPermission | null> {
    return (await this.state())[origin] ?? null
  }

  async list(): Promise<OriginPermission[]> {
    return Object.values(await this.state())
  }

  connect(origin: string, accounts: string[], chain: string): Promise<OriginPermission> {
    return this.serialize(async () => {
      if (accounts.length === 0) throw new Error('Connect at least one account.')
      const current = await this.get(origin)
      const permission: OriginPermission = { ...(current ?? {}), origin, accounts: [...accounts], chain, connectedAt: current?.connectedAt ?? Date.now() }
      await this.write(origin, permission)
      return permission
    })
  }

  /** Connect another chain's accounts to the same origin (one "connected sites" list). */
  connectChain(origin: string, key: ChainAccountsKey, accounts: string[], defaultChain: string): Promise<OriginPermission> {
    return this.serialize(async () => {
      if (accounts.length === 0) throw new Error('Connect at least one account.')
      const current = await this.get(origin)
      const permission: OriginPermission = { origin, accounts: current?.accounts ?? [], chain: current?.chain ?? defaultChain, ...(current ?? {}), [key]: [...accounts], connectedAt: current?.connectedAt ?? Date.now() }
      await this.write(origin, permission)
      return permission
    })
  }

  /** Drop one chain's accounts; the origin stays connected while any chain remains. A no-op (no write) when there is nothing to drop. */
  disconnectChain(origin: string, key: 'accounts' | ChainAccountsKey): Promise<void> {
    return this.serialize(async () => {
      const current = await this.get(origin)
      if (!current) return
      if (key === 'accounts' ? current.accounts.length === 0 : current[key] === undefined) return
      const next: OriginPermission = { ...current, [key]: key === 'accounts' ? [] : undefined }
      if (key !== 'accounts') delete next[key]
      const anything = next.accounts.length > 0 || CHAIN_ACCOUNT_KEYS.some((k) => (next[k]?.length ?? 0) > 0)
      await this.write(origin, anything ? next : null)
    })
  }

  setChain(origin: string, chain: string): Promise<OriginPermission | null> {
    return this.serialize(async () => {
      const current = await this.get(origin)
      if (!current) return null
      const next = { ...current, chain }
      await this.write(origin, next)
      return next
    })
  }

  /**
   * The active EVM account changed: every origin holding an EVM grant now sees `accounts` (MetaMask behaviour).
   * An origin connected only on another chain (`accounts: []` — Solana/TON/Tron/BTC/NEAR providers, a WalletConnect
   * session without eip155) is skipped: it never passed an EVM connect and must not learn the EVM address (scan F6/F8).
   * Lock never writes `[]` here, so the skip cannot strip a real EVM grant.
   */
  setAccountsEverywhere(accounts: string[]): Promise<OriginPermission[]> {
    return this.serialize(async () => {
      const changed: OriginPermission[] = []
      for (const p of await this.list()) {
        if (p.accounts.length === 0 || sameList(p.accounts, accounts)) continue
        const next = { ...p, accounts: [...accounts] }
        await this.write(p.origin, next)
        changed.push(next)
      }
      return changed
    })
  }

  disconnect(origin: string): Promise<void> {
    return this.serialize(async () => {
      if (!(await this.get(origin))) return
      await this.write(origin, null)
    })
  }

  onChange(listener: (origin: string, permission: OriginPermission | null) => void): () => void {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  /** Unlocked: callers hold the queue. The cache changes before the await (readers see it at once) and is rolled back when storage refuses. */
  private async write(origin: string, permission: OriginPermission | null): Promise<void> {
    const prev = await this.state()
    const state = { ...prev }
    if (permission) state[origin] = permission
    else delete state[origin]
    this._state = state
    try {
      await this.storage.set(state)
    } catch (e) {
      if (this._state === state) this._state = prev
      throw e
    }
    for (const l of this._listeners) l(origin, permission)
  }
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
