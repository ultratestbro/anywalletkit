---
"@anywalletkit/kit": minor
---

`applyPolicies`: an EVM `sign` of a string whose UTF-8 encoding — what the account signs — is exactly 32 bytes is no
longer a plain message. Like a 32-byte `Uint8Array` or a `0x` + 64-hex string it is a blind hash signature (CoW
Protocol's `ethsign` orders and other verifiers of eth_sign-wrapped digests accept those 32 bytes as an order or a
transfer, and a site can grind an order until its digest is valid UTF-8): `kind: 'typedData'`, `message: false`,
`blindHash: true`, unknown destinations. It is not refused by default: without lists it is signed after `confirm`,
which should show it as a danger screen ("This looks like a hidden hash. Signing it may authorize a transfer or an
order.", Reject / Sign anyway); a `confirm` that already turns `blindHash` into one covers it without changes. New
`WriteIntent.blindHashForm` (`'bytes' | 'hex' | 'text'`, type `BlindHashForm`) says which form came, so a sheet can
word it. The length is measured on the UTF-8 bytes, not the string: 16 two-byte letters, 8 emoji or a BOM plus 29
characters are 32 bytes; 32 characters with one `é` are 33. **Breaking:** under an allowlist such a message is now
refused (`PolicyViolationError`, `allowlist`), and so it is under a blocklist without a `confirm` hook, as the other
two forms already were; `kind` for it is `'typedData'`, no longer `'message'`. Upgrade notes:
https://docs.anywallet.tech/getting-started/upgrading/.
