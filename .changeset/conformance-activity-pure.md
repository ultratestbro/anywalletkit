---
"@anywalletkit/conformance": patch
---

The activity suite checks that `describeActivity` neither sends nor signs: it looked at `sent` only, so a module that signed something while describing a transaction passed. Every fixture run and the purity check now refuse any `sign*` / `send*` / `transfer` call on the account.
