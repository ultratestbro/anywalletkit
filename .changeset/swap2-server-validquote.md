---
"@anywalletkit/protocol-swap2-core": patch
---

`createSwap2Handler` seals a quote only when it passes the engine's own `validQuote` (the provider that was asked, the asked input amount, `minDestAmount` ≤ `destAmount`, the caller's `minAmountOut` and `slippageBps`, a live expiry, sane fees / ETA / reliability); otherwise the quote action answers 502. It sealed any well-formed quote, so a client that does not re-validate (anything but the SDK's `remoteProvider`) could get a sealed quote the engine would refuse. Audit 2026-10-25 (post-release), L1.
