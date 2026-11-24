---
"@anywalletkit/swap2-assets": minor
---

Catalog data fix (2026-11-25 on-chain supply scan of every EVM token). Two entries pointed at the wrong variant of a token and now point at the real one:
- Optimism WBTC: `0x68f180fc…2095` (bridged WBTC, 483 WBTC). Before, it was `0x0555e30d…2b9c`, a WBTC OFT with 1 WBTC supply.
- Celo USDT: the native USD₮ `0x48065fbb…3d5e` (470M supply). Before, it was the bridged `0x617f3112…a546` (54k). The Celo native USD₮ is also the token the USDT0 Legacy Mesh takes, so "USDT" on Celo now routes to Tron and TON by symbol.

37 near-empty entries are removed: their whole on-chain supply was worth under $1,000, so no venue routes them, and KyberSwap answers "token not found". They include:
- sUSDe on Optimism, X Layer, zkSync, MegaETH, Scroll and Linea;
- LINK on Sonic, MegaETH, Plasma and HyperEVM;
- several BTC and ETH wrappers;
- Sei "USDT", which is USDT.kava. Sei's USDT0 stays.
