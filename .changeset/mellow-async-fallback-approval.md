---
"@anywalletkit/protocol-lending-mellow-evm": patch
---

`supply` that falls back from the sync deposit queue to the async one (the sync proof reverts on a stale report after the approval was mined) now approves the async queue too. The approvals went to the sync queue only; the async queue, which pulls the tokens itself, had no allowance and the deposit reverted.
