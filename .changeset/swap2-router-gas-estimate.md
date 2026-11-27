---
"@anywalletkit/protocol-swap2-router": minor
---

Source gas in net-value ranking counts `Quote.gasEstimate` (the gas the transaction is expected to use) when a quote has a usable one, clamped to [21,000, 3,000,000]; otherwise the previous figure (`txRequest.gasLimit`, capped, else the calldata / deposit-address defaults). Gasless quotes still count 0, and the ERC-20 approval (+50k unless the sender's allowance already covers the amount) is still added separately. Example: Ethereum, Fynd 294.50 USDC with gasLimit 275k (= 150k × 1.3 + 80k) against CoW 294.49 (gasless) now ranks Fynd first on its 150k estimate.

- RouteSet quotes, `getBestQuote` / `RoutedQuote`, remote stubs and `onUpdate` snapshots carry the two fields unchanged; `Swap2Route` gains `gasEstimate?` and `gasEstimateSource?` next to `gasUsd`. A quote with a broken estimate sits out with the rule named in `lastRefusals`.
- `allowanceReuse` and `revokeUnspentApproval` (protocol-swap2-core) are accepted on the router's engine config, survive `using(provider, routeId)`, and `swap2(options, {...})` overrides them for one call.
- `evmSourceGas`'s RPC fetch uses core's `timeoutSignal` / `anySignal` instead of `AbortSignal.timeout` / `AbortSignal.any` (Hermes).
