---
"@anywalletkit/protocol-swap2-near-intents": minor
---

`recipientType: "INTENTS"` in the provider config credits a NEAR Intents account inside `intents.near` (the account a near.com user holds) instead of withdrawing to an address on the destination chain. In that mode `destToken` may be the intents token id itself (`nep141:…` / `nep245:…`), `destAddress` must be a NEAR account id (named, implicit hex or `0x…`, refused before any request otherwise), and a corridor paused for the destination chain does not block an intents token id, since the output never leaves `intents.near`. `recipientType: "CONFIDENTIAL_INTENTS"` credits that account's Confidential Intents balance instead (where near.com keeps funds); 1Click serves it to partners only, so it requires `jwt` and throws at construction without one. The default stays `DESTINATION_CHAIN`; an unknown value throws at construction.
