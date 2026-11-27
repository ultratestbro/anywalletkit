---
"@anywalletkit/protocol-swap2-0x": minor
---

Quotes carry `gasEstimate` (`gasEstimateSource: "venue"`): 0x's own `transaction.gas` on a live quote, `gas` on an indicative price, as decimal digits (`zeroExGasEstimate(gas)`; absent, zero or another notation gives none). `txRequest.gasLimit` (gas × 1.2 + 20,000), the chain caps, the Settler checks and `ownGasEstimate` are unchanged; the estimate is always at or under the limit. Measured 2026-11-28 on 13 live keyed quotes over six chains (11 simulated cleanly): the call used 0.41–0.95 of 0x's figure (median 0.74), never more; the figure is passed on unscaled. `verify:live`'s quote check also asserts the estimate.
