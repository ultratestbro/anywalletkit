---
"@anywalletkit/wallet-evm": patch
---

`isUnlimitedAmount` (and so `describeTransaction` / `describeTypedData`'s `approve-unlimited`) uses the SDK-wide threshold, type(uint128).max: `approve(spender, 2^255 − 1)` and Permit2's uint160 max were described as bounded approvals.
