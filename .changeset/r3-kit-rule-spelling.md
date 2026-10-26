---
"@anywalletkit/kit": patch
---

Policy keys match their network in any spelling: rules under `solana:mainnet`, `tron:728126428` / `tron:mainnet`, `bitcoin:mainnet` or `eip155:0x1` now apply to accounts that report `solana:5eykt…`, `tron:0x2b6653dc`, `bip122:…`, `eip155:1` (they were silently skipped), and the `bitcoin` namespace covers `bip122`.
