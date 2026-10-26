---
"@anywalletkit/kit": patch
---

A multi-leg intent settles once per `history()` call, the same way every time: any failed leg → failed, else any confirmed leg → confirmed. Each leg used to settle the journal on its own from the status read at the start of the call, so with one leg confirmed and another failed the journal flipped between the two on every call.
