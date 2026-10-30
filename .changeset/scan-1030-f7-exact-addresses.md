---
"@anywalletkit/kit": patch
---

The allow/block lists no longer fold the case of case-sensitive addresses (scan 2026-10-30, F7). Every namespace without its own rule was lowercased, so a Solana recipient whose spelling differs from an allowlisted key only in letter case — a different public key — passed the allowlist. Now EVM, NEAR, Aptos and Starknet addresses are lowercased, Tron and TON keep their canonical forms, a Bitcoin / Zcash bech32 address (one case, either one) is lowercased, and everything else — Solana, Bitcoin and Zcash base58, unknown namespaces — is compared exactly.
