---
"@forgewallet/core": patch
"@forgewallet/wallet-evm": patch
"@forgewallet/wallet-btc": patch
"@forgewallet/wallet-solana": patch
"@forgewallet/wallet-ton": patch
"@forgewallet/wallet-tron": patch
"@forgewallet/wallet-near": patch
---

`WalletManager` keeps the 64-byte seed, never the mnemonic string: a phrase passed to a constructor is stretched there and dropped (strings cannot be zeroized, `Uint8Array`s can). Chain managers read it through `seedBytes()`; the base `dispose()` zeroizes it.
