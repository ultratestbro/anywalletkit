---
"@anywalletkit/protocol-lending-kamino-solana": patch
---

The first-deposit allowance (SOL the guard lets a Lend deposit spend on the obligation's rent, 0.045 SOL by default) is granted only when the wallet's vanilla obligation in the market does not exist. It used to be granted whenever the obligations API failed — a guess that widened what the transaction may take — and withheld whenever any obligation existed, a Multiply one included, although the deposit goes through the vanilla one. An API failure now refuses the deposit; `vanillaObligation(user, market)` (exported) derives the obligation the program uses.
