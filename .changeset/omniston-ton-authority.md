---
"@anywalletkit/protocol-swap2-omniston": patch
---

EVM → TON disclosure, second blocker: the TON output-position validator required the authority cell to name the recipient, but EVM-source positions carry `addr_none` there (live 2026-10-20, every Base → TON order); the payout target is bound in the terms cell and the pinned authority key still applies. `addr_none` is accepted, any other address is still refused.
