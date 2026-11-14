---
"@anywalletkit/protocol-swap2-router": patch
---

The router's dispatch snapshot keeps a provider's `ownGasEstimate` (new in protocol-swap2-core): without it the engine would broadcast a 0x native sale with the venue's quoted gas limit instead of the account's own estimate of the exact call.
