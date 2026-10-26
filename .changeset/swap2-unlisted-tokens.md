---
"@anywalletkit/swap2-assets": minor
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-router": patch
"@anywalletkit/protocol-swap2-lifi": patch
"@anywalletkit/protocol-swap2-uniswap": patch
"@anywalletkit/protocol-swap2-balancer": patch
"@anywalletkit/protocol-swap2-fynd": patch
---

Swaps of tokens the catalog does not list (a user's own tokens, named by EVM contract or Solana mint), opt-in with `allowUnlistedTokens: true` on the engine and on `createSwap2Handler`; off by default, nothing changes without it. The engine reads the source token's decimals with the account's `getTokenInfo` (cached; a disagreeing `fromTokenDecimals` is refused) and sends them as `QuoteParams.sourceDecimals`; approvals go to the named token for the exact amount and the quoted spender, with the same value binding as catalog tokens. LI.FI, Uniswap, Balancer and Fynd resolve the source with the new `sourceAssetOf(params)`; providers with their own asset lists keep refusing. `swap2-assets` adds `isTokenAddress`, `unlistedAsset`, `isUnlisted`, `resolveAsset` (catalog first, always) and `catalogChainId`.
