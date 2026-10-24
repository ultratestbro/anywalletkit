# @anywalletkit/backup-cloud

## 0.2.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/seed-vault@0.2.2

## 0.2.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/seed-vault@0.2.1

## 0.2.0

### Minor Changes

- 76c9f1f: New package: iCloud backups of wallet secrets as seed-vault files, stored in the app's hidden iCloud Drive container.
  
  - **Ways to open a backup:** a no-password option whose key lives in iCloud Keychain, and/or a backup password.
  - **API:** `saveBackup` (reads the file back to verify), `checkBackup`, `listBackups`, `restoreBackup` (refuses another wallet's backup).
  - **Setup:** an Expo config plugin for the iCloud entitlements. Android comes next.

### Patch Changes

- 893109b: The iCloud Keychain backup key is now `WhenUnlocked`: never readable while the phone is locked, after-first-unlock included. Keys written by 0.1.0 are raised on their next read.
  
  - **Reading the key:** the native module asks for the device owner (Face ID / Touch ID / passcode) before handing it out; one confirmation covers 30 s. Creating a new key asks for nothing.
  - **Backup files:** written with complete file protection.
  - **Cancelling:** a dismissed sheet is the `cancelled` error.
- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [e4083a3]
- Updated dependencies [3e6a63e]
  - @anywalletkit/seed-vault@0.2.0
