---
"@anywalletkit/protocol-swap2-omniston": minor
---

A reused quote id can no longer rebind an order after its HTLC secret exists. `trackIntent` discloses a secret only when the context it is checked against is the exact order the secret was locked to (its stored binding of trader, destination, chain, assets and units) — a context rewritten under the same quote id after the secret was made gets nothing. A fresh quote's context is claimed instead of overwritten, in the order and the TON-swap paths alike: another user's quote under a held id is refused, the same user's re-quote refreshes it. `OmnistonQuoteStore` takes an optional atomic `claim(quoteId, json)` (create-if-absent; the in-memory store has one) — **give your durable store one**, or claiming falls back to check-then-save. The TON-source build re-saves its bound context, as the EVM build does.
