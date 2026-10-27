---
"@anywalletkit/protocol-swap2-near-intents": patch
---

`trackIntent` maps 1Click's `KNOWN_DEPOSIT_TX` status (the deposit transaction is known to 1Click but not yet credited). It was missing from the status table, so it came back as `pending` with `depositReceived: false`, and an app that has no source hash of its own (a deposit sent from another wallet, a lost notify) could expire a swap that was already on its way. It is now `pending` with `depositReceived: true`, like `PROCESSING` and `INCOMPLETE_DEPOSIT`.
