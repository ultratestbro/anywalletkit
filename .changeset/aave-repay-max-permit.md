---
"@anywalletkit/protocol-lending-aave-evm": patch
---

`repay({amount: 'max'})` on the permit road works. It sent `repayWithPermit(asset, uint256.max, …)`; the Pool calls `permit(owner, pool, amount, …)` with the amount it is given while the signature covered the debt plus 0.1 %, so the permit failed and the repay reverted every time. The permitted amount is now passed; Aave repays at most the debt.
