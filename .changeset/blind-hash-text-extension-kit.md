---
"@anywalletkit/extension-kit": minor
---

A `personal_sign` whose message comes as text but whose UTF-8 encoding — the bytes the signer signs — is exactly
32 bytes is no longer a normal message: it reaches the sheet with `blindHash: true` and the new
`blindHashForm: 'text'`. Those are the same 32 bytes behind the EIP-191 "\n32" prefix that CoW Protocol's
`ethsign` order scheme and similar verifiers accept as an order or a transfer, and a site can grind an order until
its digest is valid UTF-8 and send it decoded. It is not refused, and `allowBlindHash` does not change it: show it as
a danger screen ("This looks like a hidden hash. Signing it may authorize a transfer or an order.", Reject / Sign
anyway). A sheet that already turns `blindHash` into a danger screen covers it without changes. The hex form
(`0x` + 64 hex) is unchanged — refused unless `allowBlindHash`, then `blindHash: true` — and now also carries
`blindHashForm: 'hex'`. The 32-byte check reads the bytes the signer is handed (hex decoded, any other string as
UTF-8), not the string's length: multi-byte characters, a BOM and hex-looking text count as the bytes they encode
to. New type `BlindHashForm`.
