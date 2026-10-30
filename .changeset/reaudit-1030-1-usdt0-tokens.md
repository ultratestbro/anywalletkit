---
"@anywalletkit/protocol-swap2-usdt0": patch
---

`usdt0VerifyQuote` binds the tokens the app asked for (re-audit 2026-10-30, #1). It checked the send's amount, eid, recipient and fee, but not the request's tokens, and the OFT spends its own token whatever the request named: a compromised backend could answer "Arbitrum USDC → …" with a valid USDT0 send. Both the source and the destination token must now name the deployment's USDT / USDT0 (contract address or a symbol the catalog does not bind elsewhere), as the local provider already required. Honest USDT0 routes are unchanged.
