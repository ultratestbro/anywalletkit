---
"@anywalletkit/wallet-solana": patch
"@anywalletkit/protocol-swap2-lifi": patch
---

LI.FI's Solana bridges other than Mayan — Relay, LayerSwap, NEAR Intents, LI.FI Intents and whatever else LI.FI offers from Solana — quote and execute again as before. From Solana the provider no longer restricts LI.FI to Mayan (no `allowBridges` / `denyBridges` of its own, a `chooseRoute` policy's pick passes through, Relay included), and neither the provider, `lifiVerifyQuote` nor the account's `bridgeOut` check refuses a transaction for calling no Mayan program.

Be aware: these bridges deposit to an address, an order id or a program whose recipient lives in an off-chain order or in data the device does not read, so the account does NOT check their recipient. With or without `bridgeOut` they are held to what they were held to before: the program allowlist and the `maxLamportsOut` / `maxTokenOut` ceilings. Only Mayan routes (Swift, MCTP, Fast MCTP) are recipient-, token- and minimum-checked on the device. EVM sources are unchanged: Relay, Garden, deBridge DLN and ThorSwap Diamond calls stay refused and Relay / Garden stay denied in the request. LI.FI Intents calls a program outside `DEFAULT_PROGRAM_ALLOWLIST`, as before: it passes only for an app that allows that program.

Nothing to change in apps.
