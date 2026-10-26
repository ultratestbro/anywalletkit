/**
 * Builtin networks plus what the user changed, persisted as one JSON value.
 *
 * Rules (NETWORKS.md):
 * - a builtin entry (catalog mainnet or default testnet) cannot be deleted; the
 *   user can only PREPEND RPCs and flip toggles — its public list stays as the
 *   fallback unless `onlyOwnRpc` is set;
 * - a custom network (user- or site-added) has no fallback by definition;
 * - `rpcUrlsFor(caip2)` is what every consumer reads: healthy user RPCs first,
 *   then the builtin list;
 * - a user RPC whose verification failed is recorded with its error and
 *   skipped until the user fixes or removes it (an RPC that changes chain id
 *   under us is a poisoning attempt);
 * - the "allow http for local nodes" opt-in lives in the same store.
 */
import { BUILTIN_NETWORKS, familyOf } from './catalog.js'
import type { JsonStorage, Network, VerifyResult } from './types.js'
import { checkRpcUrl, checkRpcUrls, type UrlPolicyReason } from './url.js'

/** Why a user RPC is parked: the error and when it was seen. */
export interface RpcIssue {
  error: string
  at: number
  reported?: string
}

/** What the store persists: only deltas from the builtin table, so a shipped list update reaches every install. */
export interface NetworksState {
  /** Format version. */
  v: 1
  /** Accept `http://` RPCs on private addresses. */
  allowHttpLocal: boolean
  /** Per builtin caip2: the user's additions and toggles. */
  overrides: Record<string, NetworkOverride>
  /** User- or site-added networks (never a builtin caip2). */
  custom: Network[]
  /** Per caip2 → per URL: why a user RPC is skipped. */
  issues: Record<string, Record<string, RpcIssue>>
}

/** What the user changed on one built-in network. */
export interface NetworkOverride {
  /** Endpoints tried before the shipped list. */
  userRpcs?: string[]
  /** Use only `userRpcs`, never the shipped list. */
  onlyOwnRpc?: boolean
  /** Read balances over the user's RPC instead of the app's server. */
  balancesViaOwnRpc?: boolean
  /** Switched on or off by the user. */
  enabled?: boolean
}

/** A network as the table serves it: the model plus which RPCs are the user's and which are skipped. */
export interface NetworkEntry extends Network {
  /** RPCs the user (or a site) supplied, in order. For a custom network this is every RPC. */
  userRpcs: string[]
  /** The shipped list (empty for a custom network). */
  builtinRpcs: string[]
  /** User RPCs currently skipped, with the reason. */
  issues: Record<string, RpcIssue>
}

/**
 * Thrown by {@link NetworksTable} writes: a built-in network cannot be removed or replaced, the
 * network is unknown, a URL breaks the policy, the network is invalid, or the last RPC of a custom
 * network would be removed; and by the sync endpoint readers before `load()` (`not-loaded`).
 */
export class NetworkError extends Error {
  constructor(readonly code: 'builtin' | 'unknown-network' | 'url-policy' | 'bad-network' | 'last-rpc' | 'not-loaded', message: string, readonly reason?: UrlPolicyReason) {
    super(message)
    this.name = 'NetworkError'
  }
}

const EMPTY: NetworksState = { v: 1, allowHttpLocal: false, overrides: {}, custom: [], issues: {} }

const ref = (caip2: string) => caip2.split(':')[1] ?? ''

/**
 * The wallet's networks and their endpoints: the shipped catalog and testnets plus what the user
 * and sites added. Storage holds only the changes, so app updates with new endpoints reach every
 * install. Call `load()` once at start; the `…Sync` readers answer from memory after that.
 */
export class NetworksTable {
  private _state: NetworksState | null = null
  private _loading: Promise<NetworksState> | null = null
  private _writes: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly storage: JsonStorage<NetworksState>, readonly builtins: readonly Network[] = BUILTIN_NETWORKS) {}

  /** Read the stored state once; later calls answer from memory. Safe to call many times. */
  async load(): Promise<void> {
    await this.state()
  }

  /** Whether `load()` has completed — before that `listSync` / `getSync` answer builtin-only and the sync endpoint readers throw. */
  get loaded(): boolean {
    return this._state !== null
  }

  private requireLoaded(reader: string): void {
    if (this._state === null) throw new NetworkError('not-loaded', `NetworksTable.${reader}() before load(): await table.load() once at start, or use the async reader.`)
  }

  /** Fires after every write (UI refresh). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  // ---- reads ----

  /** Every network with its effective endpoints and issues. */
  async list(): Promise<NetworkEntry[]> {
    const s = await this.state()
    return this.entries(s)
  }

  /** Same as `list()` from memory; builtin table only before `load()`. */
  listSync(): NetworkEntry[] {
    return this.entries(this._state ?? EMPTY)
  }

  /** One network, or `null` when unknown. */
  async get(caip2: string): Promise<NetworkEntry | null> {
    return (await this.list()).find((n) => n.caip2 === caip2) ?? null
  }

  /** Same as `get()` from memory. */
  getSync(caip2: string): NetworkEntry | null {
    return this.listSync().find((n) => n.caip2 === caip2) ?? null
  }

  /** Endpoints to try, in order: healthy user RPCs, then the builtin list unless `onlyOwnRpc`. Empty for an unknown network. */
  async rpcUrlsFor(caip2: string): Promise<string[]> {
    await this.state()
    return this.rpcUrlsForSync(caip2)
  }

  /**
   * `rpcUrlsFor` from memory — what a sync consumer (a viem client factory) reads. Throws
   * `NetworkError('not-loaded')` before `load()`: the builtin list would ignore the user's own RPCs
   * and their `onlyOwnRpc` choice.
   */
  rpcUrlsForSync(caip2: string): string[] {
    this.requireLoaded('rpcUrlsForSync')
    const n = this.getSync(caip2)
    if (!n) return []
    const healthy = n.userRpcs.filter((u) => !n.issues[u])
    if (n.kind === 'custom') return healthy
    return n.onlyOwnRpc && healthy.length ? healthy : [...healthy, ...n.builtinRpcs]
  }

  /** Whether the first endpoint a consumer will use is user- or site-supplied (→ "Custom RPC — simulation not trusted"). Throws before `load()`. */
  usesUserRpcSync(caip2: string): boolean {
    this.requireLoaded('usesUserRpcSync')
    const n = this.getSync(caip2)
    if (!n) return false
    return n.kind === 'custom' || n.userRpcs.some((u) => !n.issues[u])
  }

  /** Same as `usesUserRpcSync()`, after loading. */
  async usesUserRpc(caip2: string): Promise<boolean> {
    await this.state()
    return this.usesUserRpcSync(caip2)
  }

  /** Whether `http://` RPCs on private addresses are accepted. */
  async allowHttpLocal(): Promise<boolean> {
    return (await this.state()).allowHttpLocal
  }

  /** Same as `allowHttpLocal()` from memory. */
  allowHttpLocalSync(): boolean {
    return this._state?.allowHttpLocal ?? false
  }

  // ---- writes ----
  // Each write is one serialized read → change → save (see `update`): two at once both land.

  /** Turn the `http://` on private addresses setting on or off. */
  async setAllowHttpLocal(v: boolean): Promise<void> {
    await this.update((s) => ({ ...s, allowHttpLocal: v }))
  }

  /** Add a custom network. Refused for a builtin caip2 (prepend RPCs with `addRpc` instead) and for RPCs outside the URL policy. */
  async add(network: Network): Promise<void> {
    await this.update((s) => {
      if (this.builtin(network.caip2)) throw new NetworkError('builtin', `${network.caip2} is a builtin network — add your RPC to it instead.`)
      if (!familyOf(network.caip2) || familyOf(network.caip2) !== network.family) throw new NetworkError('bad-network', `${network.caip2} does not belong to the ${network.family} family.`)
      if (!network.name.trim() || !ref(network.caip2)) throw new NetworkError('bad-network', 'A network needs a name and a chain id.')
      const urls = checkRpcUrls(network.rpcs, { allowHttpLocal: s.allowHttpLocal })
      if (!urls.ok) throw new NetworkError('url-policy', urls.message, urls.reason)
      if (urls.urls.length === 0) throw new NetworkError('bad-network', 'A custom network needs at least one RPC endpoint.')
      const custom = s.custom.filter((n) => n.caip2 !== network.caip2)
      custom.push({ ...network, kind: 'custom', rpcs: urls.urls })
      const issues = { ...s.issues }
      delete issues[network.caip2]
      return { ...s, custom, issues }
    })
  }

  /** Remove a custom network. Builtins cannot be removed (disable them instead). */
  async remove(caip2: string): Promise<void> {
    await this.update((s) => {
      if (this.builtin(caip2)) throw new NetworkError('builtin', `${caip2} is a builtin network and cannot be removed — disable it instead.`)
      if (!s.custom.some((n) => n.caip2 === caip2)) throw new NetworkError('unknown-network', `${caip2} is not in the table.`)
      const issues = { ...s.issues }
      delete issues[caip2]
      return { ...s, custom: s.custom.filter((n) => n.caip2 !== caip2), issues }
    })
  }

  /** Replace the user's RPC list for a network (prepended to the builtin list; the whole list for a custom network). */
  async setRpcs(caip2: string, rpcs: readonly string[]): Promise<void> {
    await this.update((s) => this.withRpcs(s, caip2, rpcs))
  }

  /**
   * Add a user RPC after the existing user RPCs, before the shipped list. Check it with
   * `checkRpcUrl` and `verifyNetwork` first.
   *
   * @throws {@link NetworkError} `unknown-network`, or `url-policy` for a URL the policy refuses.
   */
  async addRpc(caip2: string, url: string): Promise<void> {
    await this.update((s) => {
      const n = this.entries(s).find((e) => e.caip2 === caip2)
      if (!n) throw new NetworkError('unknown-network', `${caip2} is not in the table.`)
      return this.withRpcs(s, caip2, [...n.userRpcs.filter((u) => u !== url.trim()), url.trim()])
    })
  }

  /**
   * Remove a user RPC.
   *
   * @throws {@link NetworkError} `unknown-network`, or `last-rpc` for the last RPC of a custom
   * network.
   */
  async removeRpc(caip2: string, url: string): Promise<void> {
    await this.update((s) => {
      const n = this.entries(s).find((e) => e.caip2 === caip2)
      if (!n) throw new NetworkError('unknown-network', `${caip2} is not in the table.`)
      return this.withRpcs(s, caip2, n.userRpcs.filter((u) => u !== url))
    })
  }

  /** Switch a network on or off (testnets ship off). */
  async enable(caip2: string, enabled: boolean): Promise<void> {
    await this.patch(caip2, { enabled })
  }

  /** Use only the user's RPCs for this network, dropping the shipped fallback. */
  async setOnlyOwnRpc(caip2: string, onlyOwnRpc: boolean): Promise<void> {
    await this.patch(caip2, { onlyOwnRpc })
  }

  /** Read balances over the user's RPC instead of the app's server. */
  async setBalancesViaOwnRpc(caip2: string, balancesViaOwnRpc: boolean): Promise<void> {
    await this.patch(caip2, { balancesViaOwnRpc })
  }

  /** Record a verification result for one user RPC: a failure parks the URL (with the reason), a pass clears it. */
  async markRpc(caip2: string, url: string, result: VerifyResult, now: number = Date.now()): Promise<void> {
    await this.update((s) => {
      const forChain = { ...(s.issues[caip2] ?? {}) }
      if (result.ok) delete forChain[url]
      else forChain[url] = { error: result.error ?? 'verification failed', at: now, ...(result.reported ? { reported: result.reported } : {}) }
      return { ...s, issues: { ...s.issues, [caip2]: forChain } }
    })
  }

  /** Forget everything the user changed. */
  async reset(): Promise<void> {
    await this.update(() => ({ ...EMPTY }))
  }

  // ---- internals ----

  private builtin(caip2: string): Network | undefined {
    return this.builtins.find((n) => n.caip2 === caip2)
  }

  private async patch(caip2: string, patch: NetworkOverride): Promise<void> {
    await this.update((s) => {
      if (this.builtin(caip2)) return { ...s, overrides: { ...s.overrides, [caip2]: { ...s.overrides[caip2], ...patch } } }
      if (!s.custom.some((n) => n.caip2 === caip2)) throw new NetworkError('unknown-network', `${caip2} is not in the table.`)
      const { userRpcs: _ignored, ...fields } = patch
      return { ...s, custom: s.custom.map((n) => (n.caip2 === caip2 ? { ...n, ...fields } : n)) }
    })
  }

  /** `s` with the user's RPC list of `caip2` replaced (see `setRpcs`). */
  private withRpcs(s: NetworksState, caip2: string, rpcs: readonly string[]): NetworksState {
    const urls = checkRpcUrls(rpcs, { allowHttpLocal: s.allowHttpLocal })
    if (!urls.ok) throw new NetworkError('url-policy', urls.message, urls.reason)
    const issues = { ...s.issues, [caip2]: Object.fromEntries(Object.entries(s.issues[caip2] ?? {}).filter(([u]) => urls.urls.includes(u))) }
    if (this.builtin(caip2)) return { ...s, overrides: { ...s.overrides, [caip2]: { ...s.overrides[caip2], userRpcs: urls.urls } }, issues }
    if (!s.custom.some((n) => n.caip2 === caip2)) throw new NetworkError('unknown-network', `${caip2} is not in the table.`)
    if (urls.urls.length === 0) throw new NetworkError('last-rpc', 'A custom network needs at least one RPC endpoint — remove the network instead.')
    return { ...s, custom: s.custom.map((n) => (n.caip2 === caip2 ? { ...n, rpcs: urls.urls } : n)), issues }
  }

  private entries(s: NetworksState): NetworkEntry[] {
    // With "Allow http for local nodes" off, a plain-http local RPC stored while it was on is parked
    // (skipped, with the reason) instead of still being used; turning the setting on again restores it.
    const parked = (urls: readonly string[], stored: Record<string, RpcIssue> | undefined): Record<string, RpcIssue> => {
      if (s.allowHttpLocal) return stored ?? {}
      const out = { ...(stored ?? {}) }
      for (const u of urls) {
        const r = checkRpcUrl(u, { allowHttpLocal: false })
        if (!r.ok && r.reason === 'http-not-allowed') out[u] = { error: 'http:// on a local address while "Allow http for local nodes" is off', at: 0 }
      }
      return out
    }
    const out: NetworkEntry[] = this.builtins.map((b) => {
      const o = s.overrides[b.caip2] ?? {}
      const userRpcs = o.userRpcs ?? []
      return {
        ...b,
        rpcs: [...userRpcs, ...b.rpcs],
        ...(o.onlyOwnRpc !== undefined ? { onlyOwnRpc: o.onlyOwnRpc } : {}),
        ...(o.balancesViaOwnRpc !== undefined ? { balancesViaOwnRpc: o.balancesViaOwnRpc } : {}),
        enabled: o.enabled ?? b.enabled,
        userRpcs,
        builtinRpcs: [...b.rpcs],
        issues: parked(userRpcs, s.issues[b.caip2]),
      }
    })
    for (const c of s.custom) {
      if (this.builtin(c.caip2)) continue // a stored custom entry for a shipped chain is ignored: a site must not replace Ethereum's endpoints
      out.push({ ...c, kind: 'custom', rpcs: [...c.rpcs], userRpcs: [...c.rpcs], builtinRpcs: [], issues: parked(c.rpcs, s.issues[c.caip2]) })
    }
    return out
  }

  private async state(): Promise<NetworksState> {
    if (this._state) return this._state
    this._loading ??= (async () => {
      let stored: NetworksState | null
      try {
        stored = await this.storage.get()
      } catch (e) {
        // A failed read is not an empty table: that would answer builtin-only (ignoring onlyOwnRpc)
        // and the next write would replace the user's stored RPCs. Stay unloaded; a retry reads again.
        this._loading = null
        throw e
      }
      const s: NetworksState = stored && stored.v === 1
        ? { v: 1, allowHttpLocal: stored.allowHttpLocal === true, overrides: stored.overrides ?? {}, custom: Array.isArray(stored.custom) ? stored.custom : [], issues: stored.issues ?? {} }
        : { ...EMPTY }
      this._state = s
      return s
    })()
    return this._loading
  }

  /**
   * One write: read the current state, apply `change`, persist, then swap it into memory and
   * notify. Writes queue behind each other, so each sees the last one's result; a failed save
   * (or a refusal thrown by `change`) leaves memory as stored.
   */
  private update(change: (s: NetworksState) => NetworksState): Promise<void> {
    const run = this._writes.then(async () => {
      const next = change(await this.state())
      await this.storage.set(next)
      this._state = next
      for (const fn of this.listeners) fn()
    })
    this._writes = run.catch(() => undefined)
    return run
  }
}
