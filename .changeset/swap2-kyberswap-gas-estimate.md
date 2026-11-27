---
"@anywalletkit/protocol-swap2-kyberswap": minor
---

Every quote, dry or for execution, carries `gasEstimate` = KyberSwap's `routeSummary.gas` from `GET /routes` (asked with `gasInclude=true`), `gasEstimateSource: "venue"` (`kyberGasEstimate(routeGas)` is the rule): a dry quote no longer leaves the router to assume a gas limit. Execution is unchanged (the account's own estimate, no gas limit on the transaction), and so are the checks. Measured 2026-11-28 on 16 recorded live routes over nine chains, each built call simulated: gas used ÷ `routeSummary.gas` 0.58–1.85 (median 0.73); prop-AMM routes can run over (README). The README's "Router owner" section now says that `revokeUnspentApproval: false` or `allowanceReuse: "sufficient"` leave an allowance on the generic-build router, which its owner could spend: keep the engine defaults for KyberSwap on those chains.
