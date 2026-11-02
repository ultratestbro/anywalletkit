---
"@anywalletkit/protocol-swap2-core": patch
"@anywalletkit/protocol-swap2-lifi": patch
---

A quote whose minimum sits exactly at the requested slippage is no longer refused for a rounding difference. Providers compute their minimum with their own rounding — LI.FI's Mayan answers land a few base units under floor(output × (1 − slippage)) on 18-decimal tokens — so the LI.FI provider's per-step check, `validQuote` (router, single-provider path, server) and the engine's caller-slippage check refused about half of the Mayan routes out of Solana at the default 0.5 % as "0.50 % under the quote". All three now accept a minimum up to the requested slippage plus 1 bp (`SLIPPAGE_ROUNDING_BPS`, and `slippageFloor(dest, bps)` in `@anywalletkit/protocol-swap2-core/validate`); a minimum further under the quote is still refused. Nothing to change in apps.
