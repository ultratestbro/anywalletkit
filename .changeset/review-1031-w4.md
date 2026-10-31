---
"@anywalletkit/wallet-near": minor
---

`getTransactionReceipt` returns `undefined` while a NEAR transaction is not executed yet. It used to answer `{status: 1}` (with `raw.pending`) for a transaction the node had only received or included (`final_execution_status` NONE / INCLUDED), so an app could show a payment as done before it ran. Now: `undefined` while pending (no execution status, `NotStarted` / `Started`, or NONE / INCLUDED / INCLUDED_FINAL), `status: 1` only once it executed successfully (`SuccessValue` / `SuccessReceiptId`, no failed receipt), `status: 0` with `failure` when the transaction or any receipt failed. This matches every other chain. The exported `receiptOf()` now returns `NearReceipt | undefined`, and `raw.pending` is gone: treat `undefined` as "keep polling".
