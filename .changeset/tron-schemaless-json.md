---
"@forgewallet/wallet-tron": patch
---

`verifyRawTransaction` no longer refuses every node-built or dApp transaction of a contract type the wallet has no schema for (VoteWitnessContract `votes`, AccountCreateContract `account_address` …) as `raw-mismatch`: for those types only the type and the owner are compared with the bytes, and `describeTransaction` says once that the type is not decoded (its parameters are not shown and the JSON copy of them is not trusted) instead of listing every parameter field. Types the wallet decodes but has no summary for (delegation, withdrawals …) are described with their decoded fields instead of "no decoder". A 355-transaction mainnet corpus fixture is verified in the tests.
