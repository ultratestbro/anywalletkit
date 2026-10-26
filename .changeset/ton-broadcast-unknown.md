---
"@anywalletkit/wallet-ton": minor
---

A broadcast with no definitive answer (no response, a timeout, a non-JSON body such as a proxy's HTML 502) now throws `BroadcastUnknownError` (`maybeSent: true`, `hash` = the signed body hash) instead of a plain `NetworkError`: the message may be on chain, and signing again would use the next seqno and pay twice. A node's explicit refusal (`ok: false`) stays a `NetworkError`; with several endpoints, the error is a refusal only when every one refused. New `isAnsweredRefusal(error)`; a custom `TonRpc` should mark node refusals `answered: true`, otherwise its failures count as "maybe sent".
