# @anywalletkit/seed-vault

## 0.2.5

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- f743c06: `sealBackup` and `addProtector` refuse what `openBackup` / `decodeBackup` would refuse later: a key protector label over 256 characters, or a secret large enough to push the file past the 256 KB the decoder reads. Such backups used to seal fine and fail only at restore time.

## 0.2.4

### Patch Changes

- 8aa911d: `decodeBackup` / `openBackup` refuse a password protector whose Argon2id cost is below the floor `sealBackup` enforces (m 19 MiB, t 2, p 1) with `BackupError('invalid')`; they accepted m 8 KiB / t 1, so a planted or foreign file that is far cheaper to brute-force offline looked like a normal backup. Every file this SDK sealed meets the floor and still opens. Audit 2026-10-25 (post-release), M1.

## 0.2.3

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: Seed bytes passed as a Node `Buffer` (or any view into a larger buffer) are now copied, not aliased. `Wallet`, `WalletManager` and `LocalSigner.fromSeed` took the copy with `.slice()`, which on a `Buffer` is a view sharing the caller's memory: zeroizing the input after construction changed every key derived later, and `dispose()` wiped the caller's bytes. New `copyBytes()` in core makes the independent copy; `sealBackup` copies byte secrets the same way and zeroizes its copy.

## 0.2.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).

## 0.2.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.

## 0.2.0

### Minor Changes

- 3e6a63e: New package: encrypted backup files for wallet secrets.
  
  - **Payload:** the secret is encrypted once with a random data key (XChaCha20-Poly1305), and the metadata is authenticated.
  - **Protectors:** the data key is wrapped per protector — a password through Argon2id (19 MiB × 2 by default, a hook for a native implementation) or a ≥32-byte key (passkey PRF, iCloud Keychain / Block Store, hardware key).
  - **Changing protectors:** add or remove protectors without re-encrypting the secret.
  - **Safety:** strict, bounded decoding; NFKC-normalized passwords; zeroized keys.

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
