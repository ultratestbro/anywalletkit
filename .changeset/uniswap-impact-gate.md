---
"@anywalletkit/protocol-swap2-uniswap": patch
---

`maxPriceImpactBps` (opt-in): refuse a quote whose own price-impact measure (the larger of the 1/1000 probe and the spot value loss, at one block) is at or above the limit, as `insufficient_liquidity`; when the option is set and nothing can be measured, refuse as `upstream_unavailable` (or `rate_limited`). Unset keeps today's behaviour (impact is information). A swap whose gas need exceeds the chain's per-transaction cap or block gas limit is refused (it could never be mined); a padded limit above the cap is clamped to it. Per-item RPC errors are no longer read as 'no pool'.

- With `maxPriceImpactBps` set, only the best-ranked route is gated (a refused quote never falls back to a lower-output candidate), every read is pinned to one block with transient RPC errors retried, and a probe too small to run, reverted or empty falls back to the spot measure. The refusal text reads "loses 99.8% of the value to price impact — its pools are too thin for this amount (limit 5%; best route via USDC 0.3% → 0.01%)"; a passing quote adds `providerData.valueLossBps` (spot, fees included) next to the unchanged `priceImpactBps`. `preflightDeposit` does not apply it.
- With it unset, the requests and quotes are those of 0.4.11, checked scenario by scenario against the 0.4.11 dist (the deployment check's batch now also reads the block gas limit).
- Gas: the per-transaction caps are Ethereum's 16,777,216 (EIP-7825) and Monad's 30M; elsewhere the block gas limit read on chain.
- RPC: a revert (code 3, revert data, "execution reverted") is still "no candidate"; a per-item rate limit (`-32005`, `-32007`, `429`…), node error or missing answer, and a batch refused with a JSON-RPC error, are retried and then refused as `rate_limited` / `upstream_unavailable`. `error.data` is kept. Batches stay at 10 calls, at most 4 in flight.
- Monad 62,000 MON → AUSD (the cp0x trigger case), recorded at block 125,409,523: unset, 1.130999 AUSD at impact 9981 as before; at `maxPriceImpactBps: 500`, refused "loses 99.8% …".
