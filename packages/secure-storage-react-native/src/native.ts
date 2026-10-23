import type { Protection } from './types.js'

/** One stored entry as the native side reports it — no secret, no prompt. */
export interface NativeEntry {
  key: string
  /** JSON written by the native side: `{ "p": Protection, "t": createdAtMs }`. */
  meta: string
}

export interface NativeCapabilities {
  platform: 'ios' | 'android'
  /** The device has a passcode / secure lock screen — nothing can be stored without one. */
  passcodeSet: boolean
  /** The enrolled biometry, or null when none is enrolled (strict mode then refuses). */
  biometry: 'faceId' | 'touchId' | 'opticId' | 'fingerprint' | 'face' | 'iris' | 'biometric' | null
  /** Where keys live: iOS Secure Enclave–guarded Keychain, Android StrongBox or TEE; null = unavailable. */
  hardware: 'secureEnclave' | 'strongBox' | 'tee' | null
}

/**
 * The native module surface (`ForgewalletSecureStorage`). Keys are opaque here;
 * slots, ids and policy live in the JS layer. Every method rejects with an
 * `ERR_FW_*` code (see errors.ts).
 */
export interface NativeSecureStorage {
  setItem(namespace: string, key: string, value: string, protection: Protection, prompt: NativePrompt): Promise<void>
  getItem(namespace: string, key: string, prompt: NativePrompt): Promise<string | null>
  deleteItem(namespace: string, key: string): Promise<void>
  listItems(namespace: string): Promise<NativeEntry[]>
  capabilities(): Promise<NativeCapabilities>
}

/** Text for the OS sheet. iOS shows `reason` under Face ID; Android shows `title` / `subtitle` / `cancel`. */
export interface NativePrompt {
  reason: string
  title: string
  subtitle?: string
  cancel: string
}

let cached: NativeSecureStorage | null = null

/** The installed native module; loaded on first use so the JS layer imports anywhere. */
export async function loadNative(): Promise<NativeSecureStorage> {
  if (cached) return cached
  const { requireNativeModule } = await import('expo-modules-core')
  cached = requireNativeModule<NativeSecureStorage>('ForgewalletSecureStorage')
  return cached
}
