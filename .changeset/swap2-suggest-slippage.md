---
"@anywalletkit/protocol-swap2-core": minor
---

`suggestSlippage(context, options?)` (also at `@anywalletkit/protocol-swap2-core/slippage`): auto slippage from the pair class (stable ↔ stable 0.1%, majors 0.5%, everything else 1%), half the provider-reported price impact (≤ 1%), a settle-time allowance for cross-chain routes (none for stable ↔ stable) and a quarter of recent volatility (≤ 1%), clamped to [5, 300] bps by default. Returns the parts so an app can show why. The app decides whether to use it and lets the user override.
