---
"@anywalletkit/protocol-swap2-core": patch
---

The re-quote after a mined approval is reviewed again when it differs from what `reviewExecution` approved. When the first quote expired while the engine's approval was being mined, the second pass skipped the review and re-checked only spender, amount and `minAmountOut`, so the fresh quote's calldata, call target, deposit, memo, gas limit or a worse expected output reached the signer unseen. The engine now pins the reviewed plan (everything but timing, fee estimate, ETA and the mined approvals) and calls `reviewExecution` again with the fresh plan, `requoted: true` and empty `approvals` when anything pinned changed or `destAmount` dropped; throwing there, or the fresh quote expiring during that review, revokes the allowance exactly once and sends nothing. An unchanged or better re-quote is not asked again. New optional `Swap2ExecutionPlan.requoted`. Audit 2026-10-25 (post-release), M2.
