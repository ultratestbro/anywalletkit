---
"@anywalletkit/protocol-swap2-cctp": minor
---

`cctpPins` carry `verifyQuote: cctpVerifyQuote` (scan 2026-10-30, F3), exported too. The pins named only the TokenMessenger, so a compromised backend could answer with a `depositForBurn` to its own `mintRecipient` (or another domain, token, fee or destination caller) and the engine signed it. The burn is now decoded on the device against the app's request: the input amount, the destination domain, `mintRecipient` = the recipient, the source domain's native USDC, no destination caller, a Fast or Standard threshold, `amount − maxFee` at least the quoted minimum and the caller's floor, no value, the TokenMessenger as spender, and the intent id naming this burn. Honest Fast and Standard burns are unchanged.
