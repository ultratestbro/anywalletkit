# @anywalletkit/secure-storage-react-native

[![npm](https://img.shields.io/npm/v/@anywalletkit/secure-storage-react-native?label=npm)](https://www.npmjs.com/package/@anywalletkit/secure-storage-react-native)

Where a React Native wallet keeps its seed phrases and private keys. It plugs straight into `@anywalletkit/keyring` as its `SecretStorage`:

## Install

```sh
npm install @anywalletkit/secure-storage-react-native
# or: pnpm add @anywalletkit/secure-storage-react-native  ·  yarn add @anywalletkit/secure-storage-react-native
```

On npm: [@anywalletkit/secure-storage-react-native](https://www.npmjs.com/package/@anywalletkit/secure-storage-react-native), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance. An Expo native module (`expo-modules-core` is its peer, already in every Expo app): use a development build, not Expo Go.

```ts
import { Keyring } from '@anywalletkit/keyring'
import { createSecureStorage } from '@anywalletkit/secure-storage-react-native'

const secrets = createSecureStorage({ namespace: 'my-wallet' })
const keyring = await Keyring.load({ storage, secrets, chains })
```

An Expo module (Swift + Kotlin). It works in Expo apps (prebuild / dev client, not Expo Go) and in bare React Native apps that have `expo-modules-core` installed.

## What it guarantees

| | iOS | Android (11+) |
|---|---|---|
| Where the secret lives | Keychain item, data-protection keychain | AES-256-GCM ciphertext in `noBackupFilesDir`; key in Android Keystore |
| What guards a read | `SecAccessControl` checked by the Secure Enclave, on **every** read | Keystore key in StrongBox (or TEE) that needs the user for **every** use (`CryptoObject`, no time window) |
| Leaves the device? | Never: `WhenUnlockedThisDeviceOnly`, not synchronizable, not restored from backups to another phone | Never: the key can't be exported, the file isn't in Auto Backup or device-to-device transfer |
| While the phone is locked | Unreadable | Unreadable (`setUnlockedDeviceRequired`) |
| No secure hardware / no passcode | Refused (`no-passcode`) | Refused (`not-available` / `no-passcode`), fail closed |

## Protection modes

- **`biometricsOrPasscode`** (default): Face ID / Touch ID / a fingerprint, with the device passcode as the fallback. Re-enrolling biometrics doesn't lock the user out.
- **`biometricsOnly`** (opt-in strict mode): only the biometrics enrolled **now**, with no passcode fallback. Someone who watched the user type the passcode and then stole the phone still can't open it. Adding or removing a face or finger makes the secret unreadable for good, and reads throw `biometry-changed`. Offer this only to users who have a backup.

```ts
await secrets.set(id, phrase)                                  // default mode
await secrets.setProtection(id, 'biometricsOnly')              // one read, then rewritten
const { biometry, passcodeSet, hardware } = await secrets.capabilities()
```

## Around the keyring

- **`list()` / `info(id)` / `has(id)`** read only public metadata, with no prompt.
- **`prune(keepIds)`**: the iOS Keychain survives an uninstall, but the app's account list does not. Call this on start-up with the ids your app still knows, and orphaned secrets from a previous install are deleted.
- **`migrateFrom(oldStore, ids)`** moves secrets out of `expo-secure-store` or anything else. For each id it copies the secret, reads it back, compares, and only then deletes the old copy. If the user cancels or the comparison fails, the old copy stays.
- **Replacing a secret** writes a fresh slot first and removes the old one afterwards. A cancelled or failed write never loses the secret.
- **An old copy that cannot be removed** is never left silently. `set` and `setProtection` reject with `stale-copy` (the new copy is stored; the old one may be under the weaker protection), `info` / `list` report the weakest protection of the copies still stored, and the store retries the removal on its next operation, on first use after a restart and in `prune`. Retry `setProtection` before you tell the user strict mode is on; it resolves once the old copy is gone.

## Errors

Every failure is a `SecureStorageError` with a `code`: `cancelled`, `biometry-changed`, `lockout`, `no-passcode`, `not-available`, `locked`, `auth-failed`, `invalid`, `storage`, `stale-copy`. Branch on `isSecureStorageError(err, 'biometry-changed')` and send the user to restore from backup.

## Prompts

Pass `prompts: { unlock: { reason, title, cancel }, save: {...} }`, or a `prompt` per call:

- **iOS** shows `reason` under Face ID, and writes never prompt.
- **Android** shows `title` / `reason` and prompts on writes too, because a Keystore key that needs the user can't encrypt without them.

The app's `Info.plist` needs `NSFaceIDUsageDescription`.
