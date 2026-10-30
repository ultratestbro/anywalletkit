---
"@anywalletkit/wallet-near": patch
---

An AddKey access-key permission must be exactly one known variant: `{ fullAccess: {} }` or `{ functionCall: { receiverId, methodNames, allowance? } }`. An empty, misspelled, unknown or doubled variant used to be encoded as FullAccess while `describeTransaction` gave no `full-access-key` warning. Now `assertWellFormed` (top level and inside a `signedDelegate`) refuses it with `malformed-action`, the encoder throws on it, and the description reads the same tag the encoder writes (a malformed permission gets a `dangerous-action` warning saying the wallet refuses it). New export `accessKeyPermissionTag`.
