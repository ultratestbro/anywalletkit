---
"@anywalletkit/wallet-zcash": minor
---

With the chain tip unknown, a transaction is no longer signed with expiry 0 (never expires): nothing is signed when the expiry, anti-fee-sniping or the branch id need the tip. The expiry is counted from the block the transaction lands in (tip + 1 + `expiryDelta`), and the branch id is the one in force at tip + 1. On testnet and regtest, whose upgrades activate at other heights, `consensusBranchId` must be configured (`UnsafeTransactionError` `unknown-branch-id`).
