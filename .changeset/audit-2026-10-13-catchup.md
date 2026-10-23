---
"@forgewallet/wallet-solana": patch
"@forgewallet/wallet-ton": patch
"@forgewallet/wallet-near": patch
"@forgewallet/wallet-evm": patch
"@forgewallet/tx-preview-evm": patch
"@forgewallet/protocol-approvals-evm": minor
"@forgewallet/kit": patch
"@forgewallet/protocol-swap2-near-intents": patch
---

Security audit 2026-10-13 fixes that had stayed on a side branch: Solana provider-tx guard refuses System Assign/Allocate, Token Batch and undecodable core instructions and checks ownership/authority in the post-state (F1, F2); tx-preview flags native value to unlabeled contracts and unverified token symbols (F5); approvals gets a strict `isRevokeCalldata` and a new `isRevokeTransaction` (F8); kit `applyPolicies` resolves or refuses an unknown EVM chain (F4); NEAR caps token storage deposits (F12); TON checks the jetton wallet's owner and master (F13); EVM signing detects the chain before the mismatch check and strips EIP-712 array types linearly (F16, F17); near-intents strips control characters from logs (F18).
