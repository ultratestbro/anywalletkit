import type { StorageAreaLike } from './chrome.js'

/** One JSON value under one key — the shape every small store here needs. */
export interface JsonStorage<T> {
  get(): Promise<T | null>
  set(value: T): Promise<void>
}

export function chromeJsonStorage<T>(area: StorageAreaLike, key: string): JsonStorage<T> {
  return {
    async get() { return ((await area.get(key))[key] as T | undefined) ?? null },
    async set(value) { await area.set({ [key]: value }) },
  }
}

export function memoryJsonStorage<T>(initial: T | null = null): JsonStorage<T> & { value: T | null } {
  const s = {
    value: initial,
    async get() { return s.value === null ? null : structuredClone(s.value) },
    async set(value: T) { s.value = structuredClone(value) },
  }
  return s
}
