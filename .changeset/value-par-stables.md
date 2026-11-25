---
"@anywalletkit/protocol-swap2-router": patch
---

`priceOf`, `usdValue` and `quoteValues` now price more US-dollar stablecoins at $1 when the caller's map has no price for them: USDS, PYUSD, USDe, GHO, crvUSD, frxUSD, USD1, FDUSD, USDG, AUSD, xDAI, USDbC and similar. The list already had USDC, USDT, USDT0 and DAI. Before, a lone near-total loss into one of them showed nothing. On 2026-11-25, Polygon USDC → PYUSD paid 0.08 % of the value and Arbitrum ETH → USDS paid 87 USDS for $100k. Yield-bearing wrappers (sUSDS, sUSDe, scrvUSD, sfrxUSD, USDY) are not priced at par, and the caller's own price still wins.
