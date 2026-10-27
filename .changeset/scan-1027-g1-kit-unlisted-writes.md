---
"@anywalletkit/kit": minor
---

Behind the policy wrapper, a method whose name starts with `sign`, `send`, `approve`, `revoke` or `transfer` but is not one of `GUARDED_WRITES` is now refused with `PolicyViolationError` (`policy: 'method'`), with or without a fee cap. Before, it was confirmed and called: the rules judged an intent read off its first argument, which for a chain package's internal helper (BTC `signPlan` pays its second argument) is not what gets signed. `PolicyViolationError.policy` gains the value `'method'`. NEAR's `transferActions`, which signs nothing, is listed in `UNGUARDED_WRITES`.
