---
"@anywalletkit/wallet-tron": patch
---

`signRaw`, `sendTransaction` and `signTransaction` refuse an `AccountPermissionUpdateContract` (it can hand the account's keys to someone else) unless `allowPermissionChanges: true`, and refuse contract types the wallet cannot decode unless `allowUndecodedContracts: true` (`VoteWitnessContract`, which only re-assigns votes, is still signed). New `UnsafeTransactionError` codes: `permission-change`, `undecoded-contract`.
