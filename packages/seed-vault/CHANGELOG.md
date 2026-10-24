# @anywalletkit/seed-vault

## 0.2.0

### Minor Changes

- 3e6a63e: New package: encrypted backup files for wallet secrets.
  
  - **Payload:** the secret is encrypted once with a random data key (XChaCha20-Poly1305), and the metadata is authenticated.
  - **Protectors:** the data key is wrapped per protector — a password through Argon2id (19 MiB × 2 by default, a hook for a native implementation) or a ≥32-byte key (passkey PRF, iCloud Keychain / Block Store, hardware key).
  - **Changing protectors:** add or remove protectors without re-encrypting the secret.
  - **Safety:** strict, bounded decoding; NFKC-normalized passwords; zeroized keys.

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
