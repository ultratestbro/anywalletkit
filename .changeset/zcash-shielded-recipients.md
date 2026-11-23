---
"@anywalletkit/kit": patch
---

Zcash shielded (`zs1…`), unified (`u1…`) and TEX (`tex1…`) recipients are known destinations again, on mainnet and testnet. The policy guard only accepted base58 (transparent `t1…` / `t3…`), so almost every transfer to a shielded or unified address came out `destinationUnknown`, and an allowlist refused it even when it listed that address. A recipient now counts as known when it is base58 or a Zcash bech32 / bech32m address with a valid checksum. A padded (space, U+FEFF), mixed-case, broken-checksum or other-chain address is still unknown.
