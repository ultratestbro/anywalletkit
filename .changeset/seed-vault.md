---
"@forgewallet/seed-vault": minor
---

New package: encrypted backup files for wallet secrets.

- **Payload:** the secret is encrypted once with a random data key (XChaCha20-Poly1305), and the metadata is authenticated.
- **Protectors:** the data key is wrapped per protector — a password through Argon2id (19 MiB × 2 by default, a hook for a native implementation) or a ≥32-byte key (passkey PRF, iCloud Keychain / Block Store, hardware key).
- **Changing protectors:** add or remove protectors without re-encrypting the secret.
- **Safety:** strict, bounded decoding; NFKC-normalized passwords; zeroized keys.
