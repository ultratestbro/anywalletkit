---
"@anywalletkit/extension-kit": patch
---

Swap routes carry what the wallet cannot vouch for, and BEST respects it (warnings, never refusals):

- `rank(quotes, options)` takes `RankOptions` (`slippageBps`, `depositAddressProviders`); `RouteView.warnings` lists `min-below-slippage` (the provider's minimum sits further under its own quote than the requested slippage, with `minGapBps`) and `deposit-address` (the route pays an address the provider's server assigns, e.g. a NEAR Intents 1Click deposit address). A route below the slippage is never BEST; a deposit-address route is BEST only when no other provider's route exists. The BEST route is listed first, the rest keep the output order; with no eligible route there is no BEST.
- `quoteRoutes` passes `params.slippageBps` to the providers and ranks with it, but a quote whose minimum still lands under it is kept and flagged instead of refused as "invalid"; `QuoteRoutesOptions.depositAddressProviders` names the deposit-address providers (the app's choice).
- `SwapReviewMeta.slippageBps` adds a sheet check (`Minimum within your X% slippage`, or a warning when the plan's minimum is further under the output) and `SwapApproval.slippage`; `SwapReviewMeta.depositAddressAssignedByProvider` turns the deposit check into a warning ("Deposit address assigned by the … server — funds go to an address the wallet cannot verify"), sets `SwapApproval.depositAssignedByProvider`, and the recipient check is no longer "Funds arrive at your address" on `plan.recipient` alone (status `unknown`).

Without the new options nothing changes.
