---
"@anywalletkit/wallet-evm": minor
"@anywalletkit/kit": patch
---

EVM transaction `data` must be bytes or `0x`-prefixed hex of whole bytes; anything else (`'1x…'`, no prefix, `0X`, an odd length, non-hex) is refused with `UnsafeTransactionError` before simulation, description and signing, and every `accessList` storage key must be 32 bytes of `0x`-hex. viem's `hexToBytes` drops any two leading characters and pads odd lengths, so such data was signed as different calldata than the policies and `describeTransaction` read. New export `canonicalData`. In the kit, non-canonical calldata makes the write `destinationUnknown`.
