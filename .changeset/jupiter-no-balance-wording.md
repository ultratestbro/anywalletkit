---
"@forgewallet/protocol-swap2-jupiter": patch
---

A swap the wallet cannot fund is refused in plain words: "not enough of the input token in the wallet (no token account for it)". The raw simulation error is kept after the wording.

It covers Jupiter custom errors 6024 and 6025 and System Program error 1.

6025 is not in Jupiter's published error table. It was confirmed on 2026-10-24: the same USDS / LINK / WBTC → USDC swaps fail with 6025 from an empty wallet and build fine from real holders.
