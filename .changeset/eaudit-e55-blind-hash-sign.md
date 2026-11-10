---
"@anywalletkit/extension-kit": minor
---

A `personal_sign` whose message is a raw 32-byte hash (`0x` + 64 hex) is refused (4200) before any sheet: the
bytes are signed as an EIP-191 "\n32" message, which CoW Protocol's `ethsign` order scheme, Safe owner signatures
(v > 30) and similar verifiers accept as an order or a transfer to someone else. A wallet can opt in per request with
the new `SignDeps.allowBlindHash` (or `allowBlindHash` on `classifySignRequest`); the request then reaches the sheet
with `blindHash: true`, which the sheet should show as a danger screen.
