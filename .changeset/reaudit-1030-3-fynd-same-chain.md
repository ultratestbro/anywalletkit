---
"@anywalletkit/protocol-swap2-fynd": patch
---

`fyndVerifyQuote` refuses a cross-chain request (re-audit 2026-10-30, #3). It took the router from the source chain and never compared the destination chain, so a valid source-chain swap to native ETH passed for, say, a Base → Unichain request and paid out on Base. Fynd is same-chain only, as the local provider already enforced.
