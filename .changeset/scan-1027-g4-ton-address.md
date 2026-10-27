---
"@anywalletkit/wallet-ton": minor
"@anywalletkit/kit": patch
---

TON addresses are paid only in a strict form: raw `wc:hex` (64 hex digits) or a friendly address with a valid checksum. wallet-ton refuses anything else with `UnsafeTransactionError` code `address`; @ton/core alone also accepted `'+0:…'`, `' 0:…'`, `'0.0:…'` and `'0:…:x'` as `0:…`. In the kit, a TON destination in any other spelling makes the write `destinationUnknown`, so a blocklist cannot be dodged with one.
