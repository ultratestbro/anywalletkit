---
"@anywalletkit/core": patch
"@anywalletkit/kit": patch
"@anywalletkit/seed-vault": patch
---

Seed bytes passed as a Node `Buffer` (or any view into a larger buffer) are now copied, not aliased. `Wallet`, `WalletManager` and `LocalSigner.fromSeed` took the copy with `.slice()`, which on a `Buffer` is a view sharing the caller's memory: zeroizing the input after construction changed every key derived later, and `dispose()` wiped the caller's bytes. New `copyBytes()` in core makes the independent copy; `sealBackup` copies byte secrets the same way and zeroizes its copy.
