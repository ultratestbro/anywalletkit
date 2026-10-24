---
"@forgewallet/protocol-swap2-omniston": patch
---

HTLC secrets are now bound to the order they were made for: trader, destination, source chain, assets and units. A stored secret is reused only for that exact order; a disclosed one is never handed to a new build; and a quote whose platform-issued id already carries an order is refused.

The fixed attack: a malicious platform reusing a quoteId on a shared server could make a victim sign an order locked to a preimage the resolver already knew.

The secret store's format is unchanged. The binding and the disclosure mark live under `<quoteId>#bind` and `<quoteId>#disclosed`, and completion clears all three.
