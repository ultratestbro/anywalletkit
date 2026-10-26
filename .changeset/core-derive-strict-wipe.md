---
"@anywalletkit/core": patch
"@anywalletkit/keyring": patch
---

Derivation paths are parsed strictly and derivation leaves no key material behind. `parsePath` read segments with `parseInt`, so `1.9'`, `0x10'`, `1e3'` were taken as other indexes; a segment is now a plain decimal index below 2^31, and `'` / `h` mark hardened on both curves (secp256k1 used to go through @scure/bip32's own parser, which refused `h`). `deriveSecp256k1` derives step by step and wipes the master and every intermediate node; SLIP-10 `deriveEd25519` zeroes its HMAC outputs, parent keys, chain codes and input blocks. The keyring wipes the BIP-32 master it builds for a seed's fingerprint and the derived buffer behind an exported key.
