---
"@anywalletkit/protocol-swap2-lifi": patch
---

The LI.FI Diamond check now also reads the refund, depositor and fallback addresses a bridge carries in its own data — Stargate's LayerZero fee refund, the depositor of an Across deposit (and the Across Swap API's sponsored flows), the user of a LI.FI intent, an Eco intent's creator, an M0 order's owner, a Mayan Swift order's trader, Chainflip's refund address, and the refund recipients of Centrifuge, Frax, Glacis, LayerSwap, NEAR Intents, Polymer CCTP, Superset and Symbiosis — and refuses the quote unless each one is the sender or the recipient. LI.FI's own quotes set them to the sender, so routes keep working; the check runs in the provider and in `lifiVerifyQuote` (the `lifiPins` of a `remoteProvider`). Nothing to change in apps. Superset quotes that name a third address as their refund and fallback are refused.
