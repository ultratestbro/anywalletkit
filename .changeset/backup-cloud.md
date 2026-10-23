---
"@forgewallet/backup-cloud": minor
---

New package: iCloud backups of wallet secrets as seed-vault files, stored in the app's hidden iCloud Drive container.

- **Ways to open a backup:** a no-password option whose key lives in iCloud Keychain, and/or a backup password.
- **API:** `saveBackup` (reads the file back to verify), `checkBackup`, `listBackups`, `restoreBackup` (refuses another wallet's backup).
- **Setup:** an Expo config plugin for the iCloud entitlements. Android comes next.
