---
"@anywalletkit/wallet-evm": patch
"@anywalletkit/kit": patch
---

Availability: a token's `name()` / `symbol()` answer is read only as far as a 128-character string needs (the offset and length words, then 4 bytes per character, cut back to a UTF-8 boundary), and trailing NULs are cut by a linear walk; a megabyte of NULs before one other byte no longer freezes `getTokenInfo`. EIP-712 primary-type inference uses a set, and typed data declaring more than 256 types or 4096 fields is refused before it is walked, in wallet-evm (`inferPrimaryType`, `typedDataHash`; new exports `assertTypedDataSize`, `MAX_TYPED_DATA_TYPES`, `MAX_TYPED_DATA_FIELDS`) and in the kit's `resolvePrimaryType`.
