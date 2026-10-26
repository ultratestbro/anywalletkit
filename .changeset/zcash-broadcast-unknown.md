---
"@anywalletkit/wallet-zcash": minor
---

A broadcast with no definitive answer (fetch threw, a timeout, a 5xx, an unreadable body such as a proxy's HTML 502) now throws `BroadcastUnknownError` (`maybeSent: true`, `hash` = the txid computed before sending). Blockchair used to call such a 502 "Broadcast rejected", a final verdict. A node's refusal (an error it gave, with a 4xx or a 200) stays an error, marked answered (`isAnsweredRefusal`). In failover, a refusal after an endpoint that never answered is "maybe sent". "Already in the mempool / block chain" returns the txid.
