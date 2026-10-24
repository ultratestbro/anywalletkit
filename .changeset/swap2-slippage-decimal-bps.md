---
"@anywalletkit/protocol-swap2-core": patch
---

A caller's `slippage` decimal reaches the provider as the whole bps it names: 0.0029 is 29 bps, not 28 (0.0029 × 10 000 is 28.999…96 in floating point, and a plain floor shortened 573 of the 10 001 whole-bps values by one). Decimals between whole bps still round down, and the quote check against the decimal uses the same rule.
