---
"@anywalletkit/core": minor
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-router": minor
---

Add opt-in durable swap operation journals with application-owned atomic storage,
write-ahead markers around signatures/broadcasts, and read-only reconciliation.
Ambiguous sends and post-send storage failures cannot authorize automatic retries.

Add separately reviewed, value-bounded EVM recovery with client-side contract pins,
current on-chain calldata validation and independent recovery transaction tracking.
Keep existing `awk1` status IDs and zero-value claims compatible.
