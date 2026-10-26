---
"@anywalletkit/protocol-swap2-core": patch
---

On a deposit-address route (a quote without `txRequest`), the provider's build may no longer carry calldata, a spender (`approvalAddress`) or a serialized transaction the quote never had; such a build is refused before anything is approved or sent.
