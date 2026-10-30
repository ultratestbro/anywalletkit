---
"@anywalletkit/kit": patch
---

`increaseApproval(address,uint256)` (0xd73dd623, the older StandardToken name of `increaseAllowance`) names its spender to the policies (scan 2026-10-30, F5). The spender was not a destination, so a blocklisted or non-allowlisted spender passed. A one-call `approve`, `increaseAllowance` or `increaseApproval` in `sendTransaction` / `signTransaction` is now an `approval` intent (`to` = spender, `token`, `amount`, `unlimited`); for the two increase calls `amount` is the increase, not the new total.
