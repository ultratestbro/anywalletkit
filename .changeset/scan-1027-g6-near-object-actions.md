---
"@anywalletkit/wallet-near": minor
"@anywalletkit/kit": patch
---

NEAR object transactions are validated before they are built or signed, `signBuilt` included (`UnsafeTransactionError` code `malformed-action` / `invalid-method`): every action object has exactly one known key, a function call's `methodName` is a string of the method grammar, `args` are bytes, a string or a plain object (not an array or a class instance), and `gas` / `deposit` are bigints. The borsh encoder refuses the same shapes. In the kit, an action object with more than one key, a non-string `methodName`, and `ft_transfer` / `nft_transfer` / `storage_deposit` args that are not one plain JSON object make the write `destinationUnknown`. New exports `assertWellFormed`, `isPlainObject`.
