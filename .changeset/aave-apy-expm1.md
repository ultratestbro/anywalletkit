---
"@forgewallet/protocol-lending-aave-evm": patch
---

`rayToApyPct` compounds through `expm1(n·log1p(x))` instead of `pow(1 + x, n)`: with per-second compounding (n = 31 536 000) the pow form depends on the engine's libm and drifted on Hermes/Linux.
