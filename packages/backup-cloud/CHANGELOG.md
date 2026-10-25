# @anywalletkit/backup-cloud

## 0.2.3

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
  - @anywalletkit/seed-vault@0.2.3

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
