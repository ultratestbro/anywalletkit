---
"@anywalletkit/protocol-swap2-core": minor
---

`getSupportedTokens()` now gives each token's contract address (the symbol for a native coin) as `token`, the identifier `quoteSwap2` / `swap2` take back. It used to give the provider-specific `assetId`, which is `""` for most catalog entries, and an empty token resolved to the native coin. An empty or blank `fromToken` / `toToken` is now refused with `Swap2ValidationError`.
