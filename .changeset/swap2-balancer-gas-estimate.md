---
"@anywalletkit/protocol-swap2-balancer": minor
---

Quotes carry `gasEstimate` with `gasEstimateSource: "model"`: base 80,000 per `batchSwap` plus a per-hop cost by the pool's specialization read from the pool id (two-token 36,400, minimal-swap-info 40,500, general 95,500), exported as `BALANCER_GAS_BASE`, `BALANCER_HOP_GAS`, `BALANCER_GAS_CHAINS`, `balancerSpecialization`, `balancerGasEstimate`. Set on Ethereum, OP, Base and Arbitrum, only at or under the quote's gas limit (unchanged: 160,000 + 95,000 per hop) and only for known specializations. Fit to 53 simulated module quotes on 29 pairs (2026-11-28): median 5.0 %, 90 % within 18.2 %, worst 25.1 %; two real direct batchSwaps +3.2 % and +5.2 % (`fixtures/gas/batchswap-2026-11-28.json`).
