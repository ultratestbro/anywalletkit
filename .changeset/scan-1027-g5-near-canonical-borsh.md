---
"@anywalletkit/wallet-near": minor
"@anywalletkit/kit": patch
---

NEAR: a base64 borsh transaction is signed only when it re-encodes to the exact bytes given (`UnsafeTransactionError` code `non-canonical`). Borsh strings decode strictly (invalid UTF-8 throws, a leading U+FEFF is kept instead of dropped), an Option tag other than 0/1 and an unknown global-contract mode byte are refused, and every method name a transaction carries must be ASCII letters, digits and `_` (code `invalid-method`; access-key method lists and delegated actions included), every account id it names valid (code `invalid-account`). In the kit, a NEAR function call whose method name is not plain ASCII makes the write `destinationUnknown`. A BOM in front of `ft_transfer` read as an unknown method to the policies and was signed as a clean `ft_transfer` to the attacker.
