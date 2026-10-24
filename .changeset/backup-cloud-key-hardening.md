---
"@forgewallet/backup-cloud": patch
---

The iCloud Keychain backup key is now `WhenUnlocked`: never readable while the phone is locked, after-first-unlock included. Keys written by 0.1.0 are raised on their next read.

- **Reading the key:** the native module asks for the device owner (Face ID / Touch ID / passcode) before handing it out; one confirmation covers 30 s. Creating a new key asks for nothing.
- **Backup files:** written with complete file protection.
- **Cancelling:** a dismissed sheet is the `cancelled` error.
