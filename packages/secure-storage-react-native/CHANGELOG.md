# @anywalletkit/secure-storage-react-native

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
