---
"@anywalletkit/protocol-swap2-lifi": patch
---

LI.FI routes through Eco work again. Eco's facet was upgraded to v3 on 2026-11-01, which changed both entry-point selectors and moved the refund address in its data, so every Eco route was refused as an unknown Diamond call. The new entry points are listed, the refund address is read where v3 keeps it, and because v3 no longer checks on chain that the intent pays the recipient, the device reads the intent itself: it must run on the destination chain and end in a transfer of the destination token, of at least the reviewed minimum, to the recipient. Eco routes that run elsewhere (CCTP, HyperCore, chained intents) stay refused. Nothing to change in apps.
