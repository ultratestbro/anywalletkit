---
"@anywalletkit/wallet-tron": patch
---

A prebuilt transaction whose schema-less contract type (`AccountPermissionUpdateContract`, `CreateSmartContract`, …) repeats `owner_address` is refused as non-canonical.

The decoder read the first occurrence and java-tron reads the last. A signature that every check attributed to this wallet could therefore act on another account where its key holds permission weight.
