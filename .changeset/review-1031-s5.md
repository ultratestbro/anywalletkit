---
"@anywalletkit/kit": patch
---

`wallet.history()` shows pending and failed journal intents only when the query asks about them. On the first page, intents with no matching row were added whatever `chains`, `addresses` or `since` said, and an expired pending intent of another account was marked failed by an unrelated query. An intent is now shown (and expired) only when it is at or after `since` and was signed by one of the queried accounts, or has a leg on a chain one of them is on (the destination of a cross-chain swap). EVM addresses match case-insensitively. Nothing to change in your app.
