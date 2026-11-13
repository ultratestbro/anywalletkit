---
"@anywalletkit/protocol-swap2-router": minor
---

`CrossChainRouter.lastRefusals` and `RouteSet.refusals`: the refusals of `lastRejections` (texts unchanged), one per
venue, each with its `reason` when the venue classified it, and `refusalsFor(params)` / `rejectionsFor(params)` for
one auction (keyed by the params object), so `RouterSwap2Protocol`'s "no route available" carries its own call's
`refusals` and `reason` even when quotes overlap. The router classifies its own: a quote `validQuote` refuses by
`quoteRejection` (under the floor `price_check_failed`, expired `quote_expired`, malformed `upstream_unavailable`), a
remote route to an address the app did not pin (`policy_refused`), a venue slower than the auction
(`upstream_unavailable`), a bare null (`no_route`); with nobody to ask, the disabled venues that serve the route
(`policy_refused` each) or one `unsupported_pair` entry. A venue's `onRefusal` info is normalized and filed under its
own slot, and `onRefusal` hears it as its second argument.
