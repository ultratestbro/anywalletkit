/**
 * Address poisoning: an attacker sends dust from an address whose first and
 * last characters match one the user actually paid, hoping the next copy-paste
 * picks the wrong one. The wallet has no transaction history, so it keeps its
 * own book of recipients the user confirmed (per chain) and warns when a new
 * recipient looks like one of them without being it. "Fresh address" (no
 * activity on chain) is the other half of the signal; the EVM preview computes it.
 */
import type { JsonStorage } from './storage.js'

export type RecipientsState = Record<string, string[]>

/** How many characters at each end must match (after any `0x`). */
export const LOOKALIKE_PREFIX = 4
export const LOOKALIKE_SUFFIX = 4

const norm = (a: string) => a.trim().toLowerCase().replace(/^0x/, '')

/** A known recipient that `address` imitates (same start and end, different address), or `null`. */
export function lookalikeOf(address: string, known: readonly string[]): string | null {
  const a = norm(address)
  if (a.length < LOOKALIKE_PREFIX + LOOKALIKE_SUFFIX + 1) return null
  for (const k of known) {
    const b = norm(k)
    if (b === a || b.length !== a.length) continue
    if (a.startsWith(b.slice(0, LOOKALIKE_PREFIX)) && a.endsWith(b.slice(-LOOKALIKE_SUFFIX))) return k
  }
  return null
}

/** Recipients the user confirmed on each chain (`eip155`, `solana`, …), newest last, capped. */
export class RecipientBook {
  private _state: RecipientsState | null = null

  constructor(private readonly storage: JsonStorage<RecipientsState>, private readonly cap = 500) {}

  private async state(): Promise<RecipientsState> {
    this._state ??= (await this.storage.get()) ?? {}
    return this._state
  }

  async list(namespace: string): Promise<string[]> {
    return [...((await this.state())[namespace] ?? [])]
  }

  async remember(namespace: string, address: string): Promise<void> {
    const s = { ...(await this.state()) }
    const list = (s[namespace] ?? []).filter((a) => norm(a) !== norm(address))
    list.push(address)
    s[namespace] = list.slice(-this.cap)
    await this.storage.set(s)
    this._state = s
  }

  /** `known` → the address is one the user paid before; `lookalike` → it imitates one. */
  async check(namespace: string, address: string): Promise<{ known: boolean; lookalike: string | null }> {
    const list = await this.list(namespace)
    const known = list.some((a) => norm(a) === norm(address))
    return { known, lookalike: known ? null : lookalikeOf(address, list) }
  }
}
