---
"@anywalletkit/kit": minor
---

A write whose account signs on another network than the one it was asked for is refused before any rule, `confirm` or signature (`PolicyViolationError`, `policy: 'chain'`). With one `eip155` namespace registration whose RPC is on Ethereum, `getAccount('eip155:8453')` handed out the Ethereum account and `confirm` showed Base while the signature was for Ethereum; applying both networks' rules did not prevent it. `applyPolicies` now settles the account's own network first (asking `getChainId()` when it still reports `eip155:unknown`) and compares; `Wallet.getAccount` refuses a known mismatch right away, with or without policies. Short and genesis spellings of one network match (`solana:mainnet` = `solana:5eykt…`, `tron:728126428` = `tron:0x2b6653dc`); the new `sameChain()` is exported. Audit 2026-10-25, #7.
