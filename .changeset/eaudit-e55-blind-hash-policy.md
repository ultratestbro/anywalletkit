---
"@anywalletkit/kit": patch
---

`applyPolicies`: an EVM `sign` of exactly 32 bytes (a 32-byte `Uint8Array`, or a `0x` + 64-hex string) is no longer
a plain message. It is a blind hash signature — CoW Protocol's `ethsign` order scheme and other verifiers of
eth_sign-wrapped digests turn it into an order or a transfer — so its intent is `kind: 'typedData'`,
`message: false`, `blindHash: true`, with unknown destinations: an allowlist refuses it, and so does a blocklist
without a `confirm` hook; `confirm` sees it with the new `blindHash` flag. Plain text messages are unchanged.
