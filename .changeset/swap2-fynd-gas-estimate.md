---
"@anywalletkit/protocol-swap2-fynd": minor
---

Quotes carry `gasEstimate` (`gasEstimateSource: "venue"`): Fynd's order-level `gas_estimate` plus the exported `FYND_GAS_ESTIMATE_OVERHEAD`, which is 0 as measured — no ×1.3, no flat 80,000, no approval (`fyndGasEstimate(raw)` is the rule; a quote whose order states no `gas_estimate`, or 0, carries none). `txRequest.gasLimit` is unchanged (`gas_estimate × 1.3 + 80,000`), and the pinned router, the fee-breakdown check and the simulations are untouched. Measured 2026-11-28 on 20 recorded live quotes over seven chains, each simulated with `eth_simulateV1`: gas used ÷ `gas_estimate` 0.71–1.54 (median 0.99), gas used − `gas_estimate` median −2,633, so Fynd's figure already includes the router around the pools; no swap used more than 82 % of its limit. The recordings are in `fixtures/quotes` and the README has the table.
