# @forgewallet/backup-cloud

Cloud backups for React Native wallets built on the SDK. Each seed or key becomes one encrypted [`@forgewallet/seed-vault`](../seed-vault) file in the app's hidden iCloud Drive container. The user picks how it opens:

| Option | Where the pieces live | Who can open it |
|---|---|---|
| **iCloud Keychain** (no password) | File in iCloud Drive; its 32-byte key in iCloud Keychain (end-to-end encrypted by Apple) | This app on the user's Apple devices. Neither the file nor the key opens anything alone. |
| **Password** | File in iCloud Drive | Anyone with the backup password, on any phone (Argon2id, ≥10 characters) |
| **Both** | — | Either one |

```ts
import { iCloudDrive, iCloudKeychain, saveBackup, checkBackup, listBackups, restoreBackup } from '@forgewallet/backup-cloud'

const store = iCloudDrive({ container: 'iCloud.com.example.wallet' })
const keys = iCloudKeychain()

await saveBackup({ store, keyVault: keys, password, secret: await secrets.get(source.id), meta: { type: source.type, fingerprint: source.fingerprint, label: source.label } })
await checkBackup(store, source)                 // { present, createdAt, protectors } — no prompt, nothing opened
const opened = await restoreBackup({ store, name, keyVault: keys, expect: source })  // or { password }
await secrets.set(id, opened.text()); opened.dispose()
```

`saveBackup` reads the file back and compares it before reporting success. `restoreBackup` refuses another wallet's backup when given `expect`. A device without the synced key gets `key-missing`, and can then use the password.

## Setup (Expo)

```json
["@forgewallet/backup-cloud", { "iCloudContainer": "iCloud.<your bundle id>" }]
```

The plugin adds the iCloud Documents entitlements for **your** container. Every app has its own container, because a shared one would let apps read each other's backups.

With automatic signing, Xcode registers the container on your team. `xcodebuild -allowProvisioningUpdates` needs an Apple ID in Xcode › Settings › Accounts.

Files go to `<container>/WalletBackups`, not `Documents/`, so they stay out of the Files app. iCloud Keychain needs no entitlement.

## Status

Supported today: iOS (iCloud Drive and iCloud Keychain).

Next: Android, with Google Drive `appDataFolder` (needs your OAuth client) and Block Store.

On Android, `status()` reports `unavailable`.
