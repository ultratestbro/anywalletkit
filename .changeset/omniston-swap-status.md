---
"@anywalletkit/protocol-swap2-omniston": patch
---

TON swap tracking reports a partial fill as `partial` (was `completed`) and a failed or cancelled DEX swap, whose input bounces back to the trader, as `refunded` (was `failed`).
