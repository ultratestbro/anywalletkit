export interface NativeDriveFile {
  name: string
  downloaded: boolean
  modifiedAt: number
}

/** The `ForgewalletBackupCloud` Expo module (iOS). */
export interface NativeBackupCloud {
  driveStatus(container: string): Promise<{ signedIn: boolean; container: boolean }>
  driveList(container: string, folder: string): Promise<NativeDriveFile[]>
  driveWrite(container: string, folder: string, name: string, text: string): Promise<void>
  driveRead(container: string, folder: string, name: string, timeoutMs: number): Promise<string | null>
  driveDelete(container: string, folder: string, name: string): Promise<void>
  /** Is a synced key there — no prompt. */
  keychainHas(service: string, account: string): Promise<boolean>
  /** The key, after Face ID / Touch ID / passcode (one confirmation covers 30 s). */
  keychainGet(service: string, account: string, reason: string): Promise<string | null>
  keychainSet(service: string, account: string, value: string): Promise<void>
  keychainDelete(service: string, account: string): Promise<void>
}

let cached: NativeBackupCloud | null | undefined

/** The installed module, or null where it doesn't exist (Android today, tests without injection). */
export async function loadNative(): Promise<NativeBackupCloud | null> {
  if (cached !== undefined) return cached
  try {
    const { requireNativeModule } = await import('expo-modules-core')
    cached = requireNativeModule<NativeBackupCloud>('ForgewalletBackupCloud')
  } catch {
    cached = null
  }
  return cached
}
