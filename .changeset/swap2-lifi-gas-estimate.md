---
"@anywalletkit/protocol-swap2-lifi": minor
---

EVM-source quotes carry `gasEstimate` (`gasEstimateSource: "venue"`): the `estimate` of the single `SEND` entry of LI.FI's `estimate.gasCosts`, taken only when the answer says LI.FI simulated the transaction (`stepSimulation: {status: "success", gasSource: "simulation"}`) and only at or under the transaction's gas limit (`lifiGasEstimate(gasCosts, stepSimulation, gasLimit)`, exported). The approval entry is never counted; `txRequest.gasLimit` is unchanged (LI.FI's `limit`). Price-only quotes keep their route's figure; Solana sources carry none. On 13 live quotes of 2026-11-28 the figure was 12–26 % above the simulated gas used (median +19.5 %).
