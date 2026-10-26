---
"@anywalletkit/tx-preview-evm": minor
---

`checksFor` reviews every call, not only the last. Each call's target gets `contract-known` / `contract-unknown` (transfer-shaped calls included — a contract can wear the selector; approvals excepted, their spender and amount have their own checks); native value is rated per call (`native-value` warns with the address when the receiving contract is not in `known`). An approval of 2^128 − 1 or more is unlimited (the SDK-wide threshold; 2^255 − 1 used to pass as "exact"), and a bounded approval with no `expectedApproval` is the new `approval-unchecked` (status `unknown`) instead of `approval-exact: ok`.
