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
characters are 32 bytes; 32 characters with one `é` are 33. The rule now follows the account's namespace, so it also
holds for an EVM account asked for by namespace (`getAccount('eip155')`), registered under another key, or wrapped
with `applyPolicies(account, policies, 'eip155')` — before, all three forms passed there as plain messages. The
guarded EVM account is handed the bytes that were measured (a string's UTF-8, a copy of a `Uint8Array`): the same
signature for any well-formed string, and a `TextEncoder` polyfill that miscounts cannot change what is signed.
**Breaking:** under an allowlist such a message is now refused (`PolicyViolationError`, `allowlist`), and so it is
under a blocklist without a `confirm` hook, as the other two forms already were; `kind` for it is `'typedData'`, no
longer `'message'`. **Breaking:** an EVM `sign` of anything but a string or a `Uint8Array` (an array of numbers,
another typed array, an `ArrayBuffer`, an array-like, `{ raw }`) is refused with `PolicyViolationError('method')`
before any rule or `confirm` — wallet-evm read some of them as 32 raw bytes while the policies saw a plain message. A
`Uint8Array` from another realm or a Node `Buffer` still works. Upgrade notes:
https://docs.anywallet.tech/getting-started/upgrading/.
