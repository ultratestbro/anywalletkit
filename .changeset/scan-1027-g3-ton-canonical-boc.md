---
"@anywalletkit/wallet-ton": minor
---

A message's `bodyBoc` is signed only when it is a plain single-root BoC (`UnsafeTransactionError` code `non-canonical-boc` otherwise): the generic magic, one root, no absent cells, and no cell that stores its hashes (`with_hashes`), has a level mask or is exotic, the layouts another reader may parse differently from @ton/core. The bytes are not required to round-trip: real provider BoCs order their cells differently from @ton/core. A `body` that is neither a string nor a `Cell` is refused (code `body`) instead of being replaced by `bodyBoc`. New exports `canonicalBocCell`, `messageBody`.
