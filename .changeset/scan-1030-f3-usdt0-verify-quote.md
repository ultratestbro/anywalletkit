---
"@anywalletkit/protocol-swap2-usdt0": minor
---

`usdt0Pins` carry `verifyQuote: usdt0VerifyQuote` (scan 2026-10-30, F3), exported too. The pins named only the OFT, so a compromised backend could answer with a `send` to its own `to`, another eid, a lower `minAmountLD`, its own refund address or extra options, and the engine signed it. The send is now decoded on the device against the app's request: the destination eid, `to` = the recipient, `amountLD` = the input, `minAmountLD` ≤ the input and ≥ the quoted minimum and the caller's floor, empty `extraOptions` / `composeMsg` / `oftCmd`, no LZ-token fee, refund = the trader, `msg.value` = the declared native fee = the call's `nativeFee`, the adapter as spender on Ethereum only. Honest sends are unchanged.
