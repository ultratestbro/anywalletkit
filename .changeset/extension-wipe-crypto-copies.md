---
"@anywalletkit/extension-kit": patch
---

The vault wipes the copies it hands to WebCrypto. Every input went through a fresh `ArrayBuffer` copy (`toArrayBuffer`), and the copies of the password, the scrypt KEK, the DEK, the passkey PRF output and each sealed plaintext (the recovery phrase) stayed in memory. They now go through `withSecretBuffer`, which zero-fills the copy once the call settles (WebCrypto copies its input when called); the PBKDF2 password bytes are wiped too.
