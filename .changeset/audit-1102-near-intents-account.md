---
"@anywalletkit/protocol-swap2-near-intents": patch
---

With `recipientType: "INTENTS"` or `"CONFIDENTIAL_INTENTS"`, `destAddress` must now be an intents.near account someone can sign for: a named account (`alice.near`), an implicit id (64 lowercase hex) or an implicit `0x` id (40 lowercase hex, the `nearcom:0x…` account on near.com). A dot-less id that only passes the NEAR account syntax, such as a lowercase `bc1q…` address, a `0x…` that is not 40 hex or a top-level name, is refused before any request, since an output credited there could never be moved. Lowercase a checksummed `0x` address before passing it. `DESTINATION_CHAIN` (the default) is unchanged.
