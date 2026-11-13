---
"@anywalletkit/protocol-swap2-router": minor
---

`CrossChainRouter.lastRefusals` and `RouteSet.refusals`: the refusals of `lastRejections` (texts unchanged), one per
venue, each with its `reason` when the venue classified it. The router classifies its own: a quote below the floor
(`price_check_failed`), a remote route to an address the app did not pin (`policy_refused`), a venue slower than the
auction (`upstream_unavailable`), a bare null (`no_route`); with no enabled provider serving the route, one
`unsupported_pair` entry. `RouterSwap2Protocol`'s "no route available" carries them (`refusals`, `reason`), and
`onRefusal` hears the classification as its second argument.
