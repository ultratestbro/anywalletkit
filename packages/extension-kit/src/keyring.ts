/**
 * `@forgewallet/keyring` adapters for the extension. The keyring stores public
 * metadata (names, addresses, flags) through `KeyringStorage` and one secret per
 * key source through `SecretStorage`:
 *
 * - {@link chromeKeyringStorage}: the metadata as plain JSON in `chrome.storage.local`;
 * - {@link vaultSecretStorage}: every secret sealed in the {@link Vault} under the
 *   DEK the {@link Session} holds. Each call fetches the DEK, uses it once and
 *   zeroizes it; a locked session surfaces as `VaultError('locked')`, which the
 *   service worker turns into "unlock first" for the UI.
 *
 * The keyring's secret strings (JSON with the mnemonic) are immutable JS values
 * and cannot be zeroized; the keyring reads one per operation and drops it, so
 * their lifetime is one call. The byte buffers this module owns are zeroized.
 */
import { zeroize } from '@forgewallet/core'
import type { KeyringState, KeyringStorage, SecretStorage } from '@forgewallet/keyring'
import type { StorageAreaLike } from './chrome.js'
import { utf8 } from './codec.js'
import type { Session } from './session.js'
import type { Vault } from './vault.js'

export const KEYRING_STORAGE_KEY = 'forgewallet.keyring.v1'

/** Keyring metadata (no secrets) in `chrome.storage.local`. */
export function chromeKeyringStorage(area: StorageAreaLike, key = KEYRING_STORAGE_KEY): KeyringStorage {
  return {
    async load() { const r = await area.get(key); return (r[key] as KeyringState | undefined) ?? null },
    async save(state) { await area.set({ [key]: state }) },
  }
}

/** Keyring secrets sealed in the vault; readable only while the session is unlocked. */
export function vaultSecretStorage(vault: Vault, session: Session): SecretStorage {
  const withKey = async <T>(fn: (dek: Uint8Array) => Promise<T>): Promise<T> => {
    const dek = await session.getKey()
    try { return await fn(dek) } finally { zeroize(dek) }
  }
  return {
    async get(sourceId) {
      return withKey(async (dek) => {
        const bytes = await vault.getSecret(dek, sourceId)
        if (!bytes) return null
        try { return utf8.decode(bytes) } finally { zeroize(bytes) }
      })
    },
    async set(sourceId, secret) {
      const bytes = utf8.encode(secret)
      try { await withKey((dek) => vault.setSecret(dek, sourceId, bytes)) } finally { zeroize(bytes) }
    },
    async delete(sourceId) {
      await vault.deleteSecret(sourceId)
    },
  }
}
