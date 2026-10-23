/**
 * Who may open a secret.
 *
 * - `biometricsOrPasscode` (default) — Face ID / Touch ID / fingerprint, or the
 *   device passcode as the fallback. Survives re-enrolling biometrics.
 * - `biometricsOnly` — the biometrics enrolled *now*, no passcode fallback. A
 *   thief who watched the passcode cannot open it; adding or removing a face /
 *   finger makes it unreadable for good (`biometry-changed`). Opt-in, and only
 *   sensible once the user has a backup.
 */
export type Protection = 'biometricsOrPasscode' | 'biometricsOnly'

export const PROTECTIONS: readonly Protection[] = ['biometricsOrPasscode', 'biometricsOnly']

/** Public facts about one stored secret — readable without any prompt. */
export interface StoredSecretInfo {
  id: string
  protection: Protection
  /** ms since epoch when this version of the secret was written. */
  createdAt: number
}
