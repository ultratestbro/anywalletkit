---
"@anywalletkit/core": minor
"@anywalletkit/kit": minor
---

Approval intents report what a signature really grants. Permit2 `PermitBatch` / `PermitBatchTransferFrom` list every token in the new `intent.approvals` (and are `unlimited` when any entry is); amounts are read with the signer's BigInt() rules, so `' 0x…'`, `'0X…'` and `'0b…'` spellings count; an amount the policies cannot read is reported as unlimited. Unlimited is now one SDK-wide threshold, type(uint128).max and above: core exports `UNLIMITED_ALLOWANCE` and `isUnlimitedAllowance`.
