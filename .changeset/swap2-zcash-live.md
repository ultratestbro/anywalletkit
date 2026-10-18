---
"@forgewallet/swap2-assets": patch
"@forgewallet/protocol-swap2-near-intents": patch
---

Zcash is no longer hidden in the swap catalog (the wallet signs ZEC itself now). 1Click dry quotes from Zcash use a real t-address placeholder with an origin-chain refund, like every other source — the INTENTS-side refund special case is gone.
