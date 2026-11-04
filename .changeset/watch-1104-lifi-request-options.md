---
"@anywalletkit/protocol-swap2-lifi": minor
---

Cross-chain requests from an EVM chain now ask LI.FI not to offer routes with a destination call (`allowDestinationCall=false` on `/quote` and in the route-options request). The module already refused those routes, so a pair where LI.FI picked one showed no route; it now gets a route the module accepts. The refusal stays in place as the backstop. Requests from Solana are unchanged.

New opt-in option `routeWideSlippage` (default off): sends `slippageScope=route` on EVM → EVM requests, so LI.FI applies one slippage budget to the whole route and returns a single minimum the transaction enforces, instead of applying the slippage to every step. When LI.FI can protect no route for a request, it is asked again in its default scope, and the quote is held to the same floor as before. Leaving it off keeps today's behaviour exactly.
