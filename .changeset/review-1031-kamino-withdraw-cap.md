---
"@anywalletkit/protocol-lending-kamino-solana": patch
---

A Kamino Lend `withdraw` / `quoteWithdraw` now caps what the wallet may receive, not only the minimum. The transaction the Kamino API builds is refused before signing if it pays out more than the amount asked plus the slippage tolerance (which also covers interest accrued before the block on a `'max'`), one cToken's worth at the reserve's on-chain rate and a unit of rounding. This applies to SPL tokens and to SOL. Before, an API that answered a 1 USDC request with a 50 USDC withdrawal from the same obligation would have been signed. Honest withdrawals, including full `'max'` withdrawals, are unchanged; nothing to do in apps.
