---
"@anywalletkit/kit": minor
---

`applyPolicies`: an EVM `sign` of a string whose UTF-8 encoding — what an EIP-191 signer signs — is exactly 32 bytes
is no longer a plain message. Like a 32-byte `Uint8Array` or a `0x` + 64-hex string it is a blind hash signature (CoW
Protocol's `ethsign` orders and other verifiers of eth_sign-wrapped digests accept those 32 bytes as an order or a
transfer, and a site can grind an order until its digest is valid UTF-8): `kind: 'typedData'`, `message: false`,
`blindHash: true`, unknown destinations. New `WriteIntent.blindHashForm` (`'bytes' | 'hex' | 'text'`, type
`EvmSignBlindHashForm`) says which form came, so `confirm` can make it a danger screen and word it ("This looks like a
hidden hash. Signing it may authorize a transfer or an order.", Reject / Sign anyway); a `confirm` that already turns
`blindHash` into one covers it. The length is measured on the UTF-8 bytes, not the string: 16 two-byte letters, 8
emoji or a BOM plus 29 characters are 32 bytes; 32 characters with one `é` are 33. The guarded account is handed the
caller's string as it is (a `Uint8Array` as a copy); for the `0x` + 64-hex form that means wallet-evm signs the 66
bytes of its text, as before. **Breaking:** for such text `kind` is `'typedData'`, no longer `'message'`. Without a
`confirm` hook an allowlist now refuses it (`PolicyViolationError`, `allowlist`) and so does a blocklist
(`blocklist`); with one, `confirm` gets it, under an allowlist too — the hex and bytes forms stay refused under an
allowlist before `confirm`. **Breaking:** the rule follows the account's namespace, so an EVM account asked for by
namespace (`getAccount('eip155')`), registered under another key, or wrapped with
`applyPolicies(account, policies, 'eip155')` now gets all three forms flagged — the hex and bytes forms too, which
passed there as plain messages — and refused under an allowlist. **Breaking:** a blind hash needs the account's chain
like typed data when an exact-id rule of the family (`'eip155:1'`) could be the account's own: an account that
reports `eip155:unknown` asks its RPC for the chain id first, and an offline one is refused with
`PolicyViolationError('chain')`; before, it was signed without any rule. **Breaking:** an EVM `sign` of anything but
a string or a `Uint8Array` (an array of numbers, another typed array, an `ArrayBuffer`, an array-like, `{ raw }`) is
refused with `PolicyViolationError('method')` before any rule or `confirm` — wallet-evm read some of them as 32 raw
bytes while the policies saw a plain message. A `Uint8Array` from another realm or a Node `Buffer` still works.
**Breaking:** an EVM `sign` of a string with a lone surrogate (a UTF-16 unit U+D800–U+DFFF that is not half of a
pair) is refused with `PolicyViolationError('method')` before any rule or `confirm`. The `TextEncoder` polyfill of the
Hermes setup (fastestsmallesttextencoderdecoder) encodes such a string differently from the spec — it swallows the
unit after a lone high surrogate and can drop the last byte of a trailing one — so 33 measured bytes could be signed
as 32; on every well-formed string it, the spec and the kit agree. Upgrade notes:
https://docs.anywallet.tech/getting-started/upgrading/.
