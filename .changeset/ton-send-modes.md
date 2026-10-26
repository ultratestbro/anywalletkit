---
"@anywalletkit/wallet-ton": minor
---

Send modes that drain the wallet — 128 (the whole remaining balance) and 32 (the account destroyed once empty) — are now refused locally, before any seqno or emulation, unless `allowDrainingTransactions` is set; before, only a tonapi emulation reporting the risk caught them, so `simulate: false` signed them. Prebuilt signed bodies are checked too. `describeTransaction` shows each message's `mode` and warns `carries-all-balance` / `destroys-account`. A jetton transfer's recipient and response destination now get the network (test-only flag) and workchain checks a native transfer has.
