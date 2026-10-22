/**
 * Pending swaps across service-worker restarts: records in `chrome.storage.local`,
 * a `chrome.alarms` tick every minute while anything is active, resumable by
 * the swap2 id (`awk1.<provider>.<intent>[.<sourceTxHash>]`), the provider's
 * `trackIntent` as the only source of truth.
 *
 * States (the provider's `IntentState` plus the wallet's own `claiming`):
 *   pending ──deposit seen──▶ pending (depositReceived)
 *   pending ──attested (CCTP)──▶ action-required ──user claims──▶ claiming ──mint seen──▶ completed
 *   pending ──▶ completed | failed | refunded | refund-pending | partial | cancelled | expired
 * A tracker error leaves the record as it was (with `lastError`); a record older
 * than `giveUpAfterMs` with no progress becomes `expired` so the alarm stops.
 */
import { SWAP2_ID_PREFIX, type IntentStatus } from '@forgewallet/protocol-swap2-core'
import type { JsonStorage } from './storage.js'

export type SwapRecordStatus = IntentStatus['state'] | 'claiming'

export interface SwapRecord {
  /** swap2 id — `awk1.<provider>.<intentId>[.<sourceTxHash>]` (ids minted before 2026-10-19 carry the legacy `awk1.` prefix). */
  id: string
  provider: string
  fromChain: string
  toChain: string
  fromToken: string
  toToken: string
  /** Base units. */
  amountIn: string
  destAmount: string
  recipient: string
  sourceTxHash: string | null
  destTxHash: string | null
  status: SwapRecordStatus
  depositReceived?: boolean
  /** Two-phase routes: where and whether the claim can be built now. */
  claim?: { chain: string; ready: boolean }
  createdAt: number
  updatedAt: number
  /** Last tracker problem (RPC/API), kept until the next successful check. */
  lastError?: string
  checks: number
}

export const ACTIVE_STATUSES: ReadonlySet<SwapRecordStatus> = new Set<SwapRecordStatus>(['pending', 'action-required', 'refund-pending', 'partial', 'claiming'])

/** Current swap2 status-id prefix plus the legacy prefix of ids minted before 2026-10-19 (still tracked, never minted). */
const SWAP_ID_PREFIXES = [SWAP2_ID_PREFIX, 'awk1']

export function parseSwapId(id: string): { provider: string; intentId: string; sourceTxHash?: string } | null {
  const prefix = SWAP_ID_PREFIXES.find((p) => id.startsWith(`${p}.`))
  if (!prefix) return null
  const parts = id.slice(prefix.length + 1).split('.')
  if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) return null
  const provider = decodeURIComponent(parts[0])
  const intentId = decodeURIComponent(parts[1])
  const sourceTxHash = parts[2] ? decodeURIComponent(parts[2]) : undefined
  return sourceTxHash ? { provider, intentId, sourceTxHash } : { provider, intentId }
}

export class SwapsStore {
  private _records: SwapRecord[] | null = null
  private readonly _listeners = new Set<() => void>()

  constructor(private readonly storage: JsonStorage<SwapRecord[]>) {}

  async list(): Promise<SwapRecord[]> {
    this._records ??= (await this.storage.get()) ?? []
    return [...this._records].sort((a, b) => b.createdAt - a.createdAt)
  }

  async get(id: string): Promise<SwapRecord | null> {
    return (await this.list()).find((r) => r.id === id) ?? null
  }

  async active(): Promise<SwapRecord[]> {
    return (await this.list()).filter((r) => ACTIVE_STATUSES.has(r.status))
  }

  async add(record: SwapRecord): Promise<void> {
    const all = (await this.list()).filter((r) => r.id !== record.id)
    await this.write([...all, record])
  }

  async update(id: string, patch: Partial<SwapRecord>): Promise<SwapRecord | null> {
    const all = await this.list()
    const i = all.findIndex((r) => r.id === id)
    if (i < 0) return null
    const next = { ...all[i]!, ...patch, updatedAt: patch.updatedAt ?? Date.now() }
    all[i] = next
    await this.write(all)
    return next
  }

  async remove(id: string): Promise<void> {
    await this.write((await this.list()).filter((r) => r.id !== id))
  }

  onChange(listener: () => void): () => void {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  private async write(records: SwapRecord[]): Promise<void> {
    await this.storage.set(records)
    this._records = records
    for (const l of this._listeners) l()
  }
}

export interface SwapTrackerDeps {
  store: SwapsStore
  /** The provider's view of the swap (`CrossChainRouter.trackIntent`). */
  status(record: SwapRecord): Promise<IntentStatus>
  /** Start / stop the periodic alarm (`chrome.alarms.create(name, { periodInMinutes: 1 })`). */
  alarm: { start(): Promise<void> | void; stop(): Promise<void> | void }
  now?: () => number
  /** No progress for this long → `expired` (default 48 h). */
  giveUpAfterMs?: number
}

export class SwapTracker {
  private readonly now: () => number
  private ticking: Promise<void> | null = null

  constructor(private readonly deps: SwapTrackerDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Record a just-executed swap and make sure the alarm runs. */
  async track(input: Omit<SwapRecord, 'createdAt' | 'updatedAt' | 'checks' | 'status' | 'destTxHash'> & { status?: SwapRecordStatus }): Promise<SwapRecord> {
    const t = this.now()
    const record: SwapRecord = { ...input, status: input.status ?? 'pending', destTxHash: null, createdAt: t, updatedAt: t, checks: 0 }
    await this.deps.store.add(record)
    await this.deps.alarm.start()
    return record
  }

  /** After the user's claim transaction went out: keep polling until the provider sees the mint. */
  async claimed(id: string, destTxHash: string): Promise<void> {
    await this.deps.store.update(id, { status: 'claiming', destTxHash, claim: undefined as never })
    await this.deps.alarm.start()
  }

  /** One alarm tick: check every active record once; stop the alarm when nothing is active. Concurrent ticks coalesce. */
  tick(): Promise<void> {
    this.ticking ??= this.run().finally(() => { this.ticking = null })
    return this.ticking
  }

  private async run(): Promise<void> {
    const active = await this.deps.store.active()
    if (active.length === 0) { await this.deps.alarm.stop(); return }
    const giveUp = this.deps.giveUpAfterMs ?? 48 * 60 * 60_000
    for (const record of active) {
      const patch: Partial<SwapRecord> = { checks: record.checks + 1, updatedAt: this.now() }
      try {
        const s = await this.deps.status(record)
        patch.lastError = undefined as never
        if (s.depositReceived !== undefined) patch.depositReceived = s.depositReceived
        if (s.destTxHash) patch.destTxHash = s.destTxHash
        if (s.claim) patch.claim = s.claim
        // Our own claim is out: the provider still says action-required until it sees the mint; keep "claiming".
        patch.status = record.status === 'claiming' && (s.state === 'action-required' || s.state === 'pending') ? 'claiming' : s.state
      } catch (e) {
        patch.lastError = e instanceof Error ? e.message : String(e)
        if (this.now() - record.createdAt > giveUp) patch.status = 'expired'
      }
      await this.deps.store.update(record.id, patch)
    }
    if ((await this.deps.store.active()).length === 0) await this.deps.alarm.stop()
  }
}
