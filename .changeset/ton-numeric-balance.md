---
"@anywalletkit/wallet-ton": patch
---

An empty TON account no longer reads as a malformed response: QuickNode and some orbs nodes send its balance as the number `0` (toncenter sends `"0"`), and `getBalance` / jetton balances threw `NetworkError: Malformed toncenter response` for every fresh wallet. A non-negative safe-integer number is accepted; negatives, fractions, numbers past 2^53 and `null` are still refused.
