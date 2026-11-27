---
"@anywalletkit/protocol-swap2-wrap": minor
---

Quotes carry `gasEstimate` with `gasEstimateSource: "model"` from the exported `WRAP_GAS` table: the gas `deposit()` / `withdraw(amount)` uses on each chain's pinned wrapper, measured 2026-11-28 with `eth_simulateV1` and checked against public receipts (17 chains; Sei and Scroll unwrap only). Each figure is the dearer case (a wrap into an empty balance, a partial unwrap). An overridden `wrapped` contract and unmeasured chains (Monad, Sonic, MegaETH, Morph, Gnosis, Berachain, zkSync, Flare, Avalanche, Plume, Elysium) get none. `txRequest.gasLimit` stays 90,000.
