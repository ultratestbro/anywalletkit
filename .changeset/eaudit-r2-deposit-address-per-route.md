---
"@anywalletkit/extension-kit": patch
---

The `deposit-address` route flag can now be set per route, not only per provider:

- `RankOptions.depositAddressRoute(quote)` and `QuoteRoutesOptions.depositAddressRoute(quote, params)` — the app's predicate for a provider that pays a server-assigned address only on some routes (a THORChain inbound vault on a non-EVM source chain, a Bitcoin deposit address) and verifiable calldata on the rest. A route is flagged when its provider is in `depositAddressProviders` or the predicate returns true; a predicate that throws counts as flagged.
- BEST still never goes to a flagged route while an unflagged route exists; when every route is flagged, the best of them is BEST. Flagged routes stay listed and selectable.

`depositAddressProviders` keeps working as before; without the new option nothing changes.
