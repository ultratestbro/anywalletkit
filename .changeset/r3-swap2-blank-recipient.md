---
"@anywalletkit/protocol-swap2-core": patch
"@anywalletkit/protocol-swap2-cctp": patch
"@anywalletkit/protocol-swap2-usdt0": patch
"@anywalletkit/protocol-swap2-lifi": patch
---

A blank `recipient` / `refundAddress` (`""` from an empty input) is treated as omitted: the swap goes to, and refunds to, the account itself, and the review shows that address. CCTP, USDT0 and LI.FI use their placeholder address only for dry quotes; a live quote without a recipient or refund address is refused instead of being built to the placeholder.
