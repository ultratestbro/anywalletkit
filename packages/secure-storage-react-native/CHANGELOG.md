# @anywalletkit/secure-storage-react-native

## 0.3.0

### Minor Changes

- e2ea9d4: An old copy of a secret is no longer left behind silently. After a rewrite (`set`, `setProtection`) the store swallowed a failed delete of the previous copy: `setProtection(id, 'biometricsOnly')` resolved, `info` / `list` reported strict mode while the `biometricsOrPasscode` copy stayed in the Keychain, a retry did nothing, and neither a restart nor `prune` removed it. Now `info` and `list` report the weakest protection among the copies still stored, the removal is retried on the next store operation, on first use after a restart and in `prune`, and `delete(id)` removes the oldest copy first, so a failure part-way never leaves an older copy as the one `get` reads. A `setProtection` call for the protection the newest copy already has removes any older copy without a sheet.
  
  **Breaking:** `set` and `setProtection` reject with the new `SecureStorageError` code `stale-copy` when the new copy is stored but an older one could not be removed; `prune` rejects with it when an older copy of a kept secret stays. `SecureStorageErrorCode` gains `'stale-copy'`.

## 0.2.4

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.

## 0.2.3

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.

## 0.2.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).

## 0.2.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.

## 0.2.0

### Minor Changes

- ac4a73f: New package: device secret storage for React Native wallets, plugged into the keyring as its `SecretStorage`.
  
  - **iOS:** Keychain items behind a Secure Enclave–checked access control.
  - **Android:** AES-GCM under a StrongBox / TEE Keystore key that needs the user for every use.
  - **Modes:** Face ID or passcode by default; an opt-in strict mode (current biometrics only) that fails with `biometry-changed`.
  - **Scope:** this device only and never in backups. No passcode or no secure hardware means the write is refused.
  - **Housekeeping:** `prune` after a reinstall; `migrateFrom` copies from an older store, verifies, then deletes.

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
