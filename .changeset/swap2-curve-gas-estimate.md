---
"@anywalletkit/protocol-swap2-curve": minor
---

Quotes carry `gasEstimate` with `gasEstimateSource: "model"`: a measured table of the Router NG `exchange` (base 92,500 plus one cost per step by pool type and coin count, wrap and ERC-4626 steps), exported as `CURVE_GAS_BASE`, `CURVE_STEP_GAS`, `CURVE_GAS_CHAINS`, `curveStepKind`, `curveGasEstimate`, `curveGasEstimateOfCall`. Set on Ethereum, OP, Base, Plasma and Arbitrum only, and not for routes through an unmeasured step kind. Fit to 763 real router receipts plus simulated module quotes (2026-11-28): median 4.1 %, 90 % within 11.1 %, worst 38.6 %; 76 receipts are kept in `fixtures/gas/receipts-2026-11-28.json`. The quote still has no gas limit, and the self-check, preflight and verification are unchanged.
