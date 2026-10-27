---
"@anywalletkit/wallet-tron": minor
---

Contract-call parameters encode to exactly one 32-byte word each, and must match the `functionSelector` signature in count and type (new export `encodeCall`). `uintN` / `intN` are range-checked for N (negative `uint` refused) and take a bigint, a safe integer or a decimal / `0x` string (no whitespace, `0b`, `0o`); `bytes32` is at most 32 bytes of even-length hex; `bool` must be `true` or `false`; `address` must be a string. Before, a `bytes32` or an oversized uint could emit several words and shift every argument after it, so the contract decoded other arguments than the ones the policies read.
