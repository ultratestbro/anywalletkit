---
"@anywalletkit/protocol-swap2-core": patch
"@anywalletkit/protocol-swap2-0x": patch
---

A Permit2 sale that needs an approval asks for the permit once. The engine used to sign the permit before the approvals; when the mined approval outlived the quote (an Ethereum approval against the 0x provider's 45 s TTL), the re-quote carried a new permit and the wallet asked again (permit → approve → permit). With an approval to send, the permit is now signed after it is mined, once the quote is known to be live (re-quoted otherwise) and the provider's preflight passed; one `signing` phase covers the permit and the transaction. With a standing Permit2 allowance the permit still comes first. Trade-off: a permit declined after the approval costs a revoke. An account without `signTypedData` is still refused before any approval.

`zeroExProvider`'s default `quoteTtlMs` is 120 s (was 45 s), still cut to the Permit2 deadline − 20 s for a token sale and to 90 s for a native sale.
