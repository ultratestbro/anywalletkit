---
"@anywalletkit/extension-kit": patch
---

A fee that rose after the review is asked again on a follow-up sheet that the queue limits do not refuse. `ApprovalQueue.request(input, { followUp: true })` is another sheet for a request the user has just approved: each approval pays for one follow-up of the same origin, kind and chain, which skips the per-origin / per-site / total limits and the rate limit and is shown ahead of the requests already waiting (a refused origin stays refused). The `eth_sendTransaction` re-ask uses it, carries the max fee shown before (`SignApproval.repricedFrom`), stops after `MAX_FEE_REASKS` (3) re-asks in a row with nothing signed, and refuses a new fee above `SignDeps.feeCeiling(network)` without a second sheet.
