---
"@anywalletkit/wallet-ton": minor
---

A message's `bodyBoc` is signed only when it is a canonical single-root BoC: @ton/core must write the parsed cell back byte-for-byte (with or without index and CRC), else `UnsafeTransactionError` code `non-canonical-boc`. A `body` that is neither a string nor a `Cell` is refused (code `body`) instead of being replaced by `bodyBoc`. New export `canonicalBocCell`. BoCs from @ton/core's `toBoc()` are unaffected; a serializer that orders cells differently or stores hashes is refused.
