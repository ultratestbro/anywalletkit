---
"@anywalletkit/protocol-swap2-omniston": patch
---

A feed `TRADE_STATUS_FULLY_FILLED` no longer deletes a live order's HTLC secrets (scan 2026-10-30 F10). `trackIntent` reports an order `completed` — and clears its secrets and quote context — only when every execution's secret was disclosed (in that poll or an earlier one; a terminal snapshot that lists no executions counts a recorded disclosure) or `locateEvmDelivery` / `locateTonDelivery` found the payout. Otherwise the order stays `pending` with its secrets until TTL or the app's refund backstop closes it, so a real execution that shows up later is still disclosed, and a disclosure that failed in the same poll is retried. Before, a feed that said FULLY_FILLED with no executions made the SDK report completion and forget the secret of a funded order. Disclosed execution indices are recorded under `<quoteId>#disclosed-indices` in the secret store; orders disclosed by the previous version complete as before.
