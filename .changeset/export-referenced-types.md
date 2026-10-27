---
"@anywalletkit/conformance": patch
"@anywalletkit/history-evm": patch
"@anywalletkit/protocol-lending-aave-evm": patch
"@anywalletkit/protocol-lending-kamino-solana": patch
"@anywalletkit/protocol-lending-morpho-evm": patch
"@anywalletkit/protocol-staking-native-monad": patch
"@anywalletkit/protocol-staking-native-solana": patch
"@anywalletkit/protocol-swap2-balancer": patch
"@anywalletkit/protocol-swap2-core": patch
"@anywalletkit/protocol-swap2-fynd": patch
"@anywalletkit/protocol-swap2-lifi": patch
"@anywalletkit/protocol-swap2-near-intents": patch
"@anywalletkit/protocol-swap2-omniston": patch
"@anywalletkit/protocol-swap2-router": patch
"@anywalletkit/protocol-swap2-thorchain": patch
"@anywalletkit/protocol-swap2-uniswap": patch
"@anywalletkit/protocol-swap2-wrap": patch
"@anywalletkit/seed-vault": patch
"@anywalletkit/wallet-btc": patch
"@anywalletkit/wallet-evm": patch
"@anywalletkit/wallet-near": patch
"@anywalletkit/wallet-solana": patch
"@anywalletkit/wallet-ton": patch
"@anywalletkit/wallet-tron": patch
"@anywalletkit/wallet-zcash": patch
---

Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
