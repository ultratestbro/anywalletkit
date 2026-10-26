---
"@anywalletkit/kit": patch
---

Activity descriptions take the app's own token list: `GenericDescribeOptions.tokens(chain, token)` returns `{ symbol, decimals }` for tokens outside the swap2-assets catalog (custom tokens from `@anywalletkit/tokens`). An approval of such a token used to read "Approved 0x1234…", and `approve(spender, 0)` on it was not recognised as a revoke.
