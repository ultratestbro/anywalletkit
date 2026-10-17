/**
 * The intent journal: what the app *meant* when it broadcast something, keyed by the
 * hashes it got back. On-chain history alone cannot tell "Swapped USDC → ETH via
 * 1Click" from "Sent USDC to 0xdead…", nor pair a bridge's two legs, nor show a
 * swap before the explorer indexed it. The app writes one intent per user action
 * (swap, bridge, earn deposit, send) and the kit folds it into `history()`.
 *
 * Storage is the app's: `createMemoryIntentJournal()` for tests and short-lived
 * processes; anything persistent (SQLite, AsyncStorage, a file) implements the
 * three methods. Timestamps are unix seconds, like `ChainTx.time`.
 */
import type { ActivityAsset, ActivityKind } from '@forgewallet/core'

export type IntentStatus = 'pending' | 'confirmed' | 'failed'

export interface Intent {
  /** App-chosen, unique: a UUID, or the provider's own id (1Click deposit address, LI.FI route id…). Emitted as `intent:<id>` while pending. */
  id: string
  kind: ActivityKind
  /** Unix seconds when the user confirmed the action. */
  createdAt: number
  /** Chain the action started on (CAIP-2) and the wallet address that signed. */
  chain: string
  address: string
  /** Every transaction hash this action produced or expects, source leg first. A cross-chain swap lists both legs once known. */
  hashes: Array<{ chain: string; hash: string }>
  /** What the app expected to leave / arrive (quote amounts), used while pending and when the recognizer saw nothing. */
  expect?: { assetsOut: ActivityAsset[]; assetsIn: ActivityAsset[] }
  /** Registry module name that executed it, e.g. "@forgewallet/protocol-swap2-lifi". */
  protocol?: string
  /** Venue / counterparty label, e.g. "LI.FI", "Aave v3 · Base". */
  subtitle?: string
  /** Other legs that are not this wallet's own transactions (a relayer's fill, a destination deposit). */
  related?: Array<{ chain: string; hash: string }>
  status: IntentStatus
}

export interface IntentJournal {
  /** Every intent the app still wants in the feed (pending, and confirmed ones until the app prunes them). */
  list(): Promise<Intent[]>
  /** Insert or replace by `id`. */
  put(intent: Intent): Promise<void>
  remove(id: string): Promise<void>
}

/** In-memory journal: tests, scripts, and apps that hydrate it from their own storage. */
export function createMemoryIntentJournal(initial: Intent[] = []): IntentJournal & { readonly size: number } {
  const map = new Map<string, Intent>(initial.map((i) => [i.id, i]))
  return {
    get size() { return map.size },
    async list() { return [...map.values()] },
    async put(intent) { map.set(intent.id, intent) },
    async remove(id) { map.delete(id) },
  }
}
