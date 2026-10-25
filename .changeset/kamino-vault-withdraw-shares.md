---
"@anywalletkit/protocol-lending-kamino-solana": patch
---

Earn vault withdrawals pass the wallet's guard. `withdraw` / `quoteWithdraw` declared only the asset coming in, so the share burn out of the wallet's share account read as an undeclared drain and wallet-solana refused every withdrawal of unstaked shares (`token-drain`). The expectation now also allows exactly the shares being redeemed to leave (`maxTokenOut` on the share mint); every other outflow is still refused. Audit 2026-10-25, #1.3.
