/**
 * Adapters over the `chrome.*` APIs, typed structurally so this package needs no
 * `@types/chrome` and tests can pass fakes. Promise forms (MV3) only.
 */
import type { SessionAlarms, SessionStorage } from './session.js'
import type { VaultEnvelope, VaultStorage } from './vault.js'

export interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
  /** `chrome.storage.session` only. */
  setAccessLevel?(options: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void>
}

export interface AlarmsLike {
  create(name: string, info: { when: number }): Promise<void> | void
  clear(name: string): Promise<boolean> | boolean | void
  onAlarm: { addListener(callback: (alarm: { name: string }) => void): void }
}

export const VAULT_STORAGE_KEY = 'forgewallet.vault.v1'

/** The encrypted envelope in `chrome.storage.local` (survives browser restarts; ciphertext only). */
export function chromeLocalVaultStorage(area: StorageAreaLike, key = VAULT_STORAGE_KEY): VaultStorage {
  return {
    async get() { const r = await area.get(key); return (r[key] as VaultEnvelope | undefined) ?? null },
    async set(envelope) { await area.set({ [key]: envelope }) },
    async clear() { await area.remove(key) },
  }
}

/**
 * `chrome.storage.session`: memory-only, gone when the browser exits. Access is
 * pinned to trusted contexts (the default; made explicit so a content script can
 * never read the unlocked key even if a later change opens the area to them).
 */
export function chromeSessionStorage(area: StorageAreaLike): SessionStorage {
  const ready = area.setAccessLevel ? area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }) : Promise.resolve()
  return {
    async get(key) { await ready; return (await area.get(key))[key] },
    async set(key, value) { await ready; await area.set({ [key]: value }) },
    async remove(key) { await ready; await area.remove(key) },
  }
}

/** `chrome.alarms` as one-shot named alarms. Chrome rounds alarms to ≥ 30 s in packed extensions. */
export function chromeAlarms(alarms: AlarmsLike): SessionAlarms {
  return {
    async schedule(name, when) { await alarms.create(name, { when }) },
    async clear(name) { await alarms.clear(name) },
    onFire(handler) { alarms.onAlarm.addListener((alarm) => handler(alarm.name)) },
  }
}
