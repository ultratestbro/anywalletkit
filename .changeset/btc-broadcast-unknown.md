---
"@anywalletkit/wallet-btc": minor
---

A broadcast with no definitive answer (fetch threw, a timeout, a 5xx or 408, an unreadable body) now throws `BroadcastUnknownError` (`maybeSent: true`, `hash` = the txid computed before sending) instead of a plain `NetworkError`: the transaction may be in the mempool, and building another spend would use other coins or replace it. A node's refusal (HTTP 4xx with a reason, or an error body) stays an error, marked answered (`isAnsweredRefusal`); with several clients it is a refusal only when every one refused. "Already in the mempool / block chain" returns the txid. A custom `BtcClient` should mark node refusals `answered: true`, otherwise its failures count as "maybe sent".
