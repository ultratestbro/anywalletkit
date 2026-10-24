# @anywalletkit/backup-cloud

[![npm](https://img.shields.io/npm/v/@anywalletkit/backup-cloud?label=npm)](https://www.npmjs.com/package/@anywalletkit/backup-cloud)

Cloud backups for React Native wallets built on the SDK. Each seed or key becomes one encrypted [`@anywalletkit/seed-vault`](../seed-vault) file in the app's hidden iCloud Drive container. The user picks how it opens:

## Install

```sh
npm install @anywalletkit/backup-cloud
# or: pnpm add @anywalletkit/backup-cloud  ·  yarn add @anywalletkit/backup-cloud
```

On npm: [@anywalletkit/backup-cloud](https://www.npmjs.com/package/@anywalletkit/backup-cloud), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance. An Expo native module (`expo-modules-core` is its peer, already in every Expo app): use a development build, not Expo Go.

| Option | Where the pieces live | Who can open it |
|---|---|---|
| **iCloud Keychain** (no password) | File in iCloud Drive; its 32-byte key in iCloud Keychain (end-to-end encrypted by Apple) | This app on the user's Apple devices, after Face ID / Touch ID / the device passcode. Neither the file nor the key opens anything alone. |
| **Password** | File in iCloud Drive | Anyone with the backup password, on any phone (Argon2id, ≥10 characters) |
| **Both** | — | Either one |

```ts
import { iCloudDrive, iCloudKeychain, saveBackup, checkBackup, listBackups, restoreBackup } from '@anywalletkit/backup-cloud'

const store = iCloudDrive({ container: 'iCloud.com.example.wallet' })
const keys = iCloudKeychain()

await saveBackup({ store, keyVault: keys, password, secret: await secrets.get(source.id), meta: { type: source.type, fingerprint: source.fingerprint, label: source.label } })
await checkBackup(store, source)                 // { present, createdAt, protectors } — no prompt, nothing opened
const opened = await restoreBackup({ store, name, keyVault: keys, expect: source })  // or { password }
await secrets.set(id, opened.text()); opened.dispose()
```

**Protection on the device.**
- **The key:** `WhenUnlocked`. It is never readable while the phone is locked, after-first-unlock included. Keys written by 0.1.0 are raised to this class on their next read.
- **Reading it:** the native module asks for the device owner (Face ID / Touch ID / passcode) before handing the key out, so app code can't read it silently. One confirmation covers 30 s, so a multi-wallet backup or restore asks once. Creating a new key asks for nothing.
- **The file:** written with complete file protection.
- **No strict mode:** a synced keychain item can't carry a biometric ACL, so the no-password option can't honour strict biometrics-only mode. Offer the password option to users who want that.

`saveBackup` reads the file back and compares it before reporting success. `restoreBackup` refuses another wallet's backup when given `expect`. A device without the synced key gets `key-missing`, and can then use the password.

## Setup (Expo)

```json
["@anywalletkit/backup-cloud", { "iCloudContainer": "iCloud.<your bundle id>" }]
```

The plugin adds the iCloud Documents entitlements for **your** container. Every app has its own container, because a shared one would let apps read each other's backups.

With automatic signing, Xcode registers the container on your team. `xcodebuild -allowProvisioningUpdates` needs an Apple ID in Xcode › Settings › Accounts.

Files go to `<container>/WalletBackups`, not `Documents/`, so they stay out of the Files app. iCloud Keychain needs no entitlement.

## Status

Supported today: iOS (iCloud Drive and iCloud Keychain).

Next: Android, with Google Drive `appDataFolder` (needs your OAuth client) and Block Store.

On Android, `status()` reports `unavailable`.
