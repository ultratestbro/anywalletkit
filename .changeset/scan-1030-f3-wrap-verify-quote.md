---
"@anywalletkit/protocol-swap2-wrap": minor
---

`wrapPins` carry `verifyQuote: wrapVerifyQuote` (scan 2026-10-30, F3), exported too. The pins named only the wrapped-native contract, so a remote backend could answer with any call on it. Now a wrap must be exactly `deposit()` with the input as value, an unwrap exactly `withdraw(input)` with no value, with no approval and the recipient = the sender (WETH9 pays `msg.sender`). Honest wraps and unwraps are unchanged.
