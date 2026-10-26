---
"@anywalletkit/wallet-solana": minor
---

`getTokenBalances` reads both programs' associated token accounts, so Token-2022 balances are no longer 0, and only counts an account that holds that mint. `getTokenBalance` reads the mint's program directly: a network error now throws instead of falling back to the legacy program and answering 0; an address that is not a mint is still a 0 balance.
