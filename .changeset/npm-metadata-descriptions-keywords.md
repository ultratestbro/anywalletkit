---
"@anywalletkit/conformance": patch
"@anywalletkit/core": patch
"@anywalletkit/extension-kit": patch
"@anywalletkit/history-evm": patch
"@anywalletkit/keyring": patch
"@anywalletkit/kit": patch
"@anywalletkit/protocol-swap2-balancer": patch
"@anywalletkit/protocol-swap2-core": patch
"@anywalletkit/protocol-swap2-lifi": patch
"@anywalletkit/protocol-swap2-near-intents": patch
"@anywalletkit/protocol-swap2-omniston": patch
"@anywalletkit/protocol-swap2-router": patch
"@anywalletkit/protocol-swap2-thorchain": patch
"@anywalletkit/protocol-swap2-uniswap": patch
"@anywalletkit/protocol-swap2-wrap": patch
"@anywalletkit/runtime-hermes": patch
"@anywalletkit/swap2-assets": patch
"@anywalletkit/wallet-btc": patch
"@anywalletkit/wallet-evm": patch
"@anywalletkit/wallet-near": patch
"@anywalletkit/wallet-solana": patch
"@anywalletkit/wallet-ton": patch
"@anywalletkit/wallet-tron": patch
"@anywalletkit/wallet-zcash": patch
---

npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
