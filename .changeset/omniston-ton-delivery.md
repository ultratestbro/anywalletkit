---
"@forgewallet/protocol-swap2-omniston": patch
---

EVM → TON orders report the delivery transaction: `locateTonDelivery` on the provider options, called when a completed order's output chain is TON, and `createOmnistonTonDeliveryLocator({tonApiUrl, tonApiKey, fetch})` in `validators` — the output position's jetton transfer to the recipient in the recipient's tonapi events, returned as the event id `@forgewallet/wallet-ton`'s history source uses for the same event, so a wallet can pair the TON receive with the swap. Omniston's feed names the position but never that transfer; every completed Base → TON order so far carried no `destTxHash` and showed as a swap plus a stray receive.
