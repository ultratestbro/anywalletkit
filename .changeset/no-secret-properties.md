---
"@forgewallet/core": minor
"@forgewallet/kit": minor
"@forgewallet/conformance": minor
"@forgewallet/keyring": patch
"@forgewallet/wallet-evm": patch
"@forgewallet/wallet-btc": patch
"@forgewallet/wallet-solana": patch
"@forgewallet/wallet-ton": patch
"@forgewallet/wallet-tron": patch
"@forgewallet/wallet-near": patch
"@forgewallet/wallet-zcash": patch
---

No secret is an object property anywhere. `Wallet` no longer keeps the seed phrase string: it turns the phrase into the 64-byte seed in the constructor, hands each chain manager a copy, and `dispose()` zeroizes it and refuses later calls; `new Wallet(seedBytes)` and managers built from seed bytes are accepted (copied). `LocalSigner` keys and seeds and `WalletManager` seeds live in module WeakMaps, so `console.log`, `JSON.stringify`, `util.inspect` and crash reporters see only public fields; `LocalSigner.toJSON()` is the public view. Accounts get leaf signers (`LocalSigner.leafFromSeed`, `deriveLeaf`) that hold only their own key, never a copy of the master seed. Before: `JSON.stringify(account)` contained the private key and the master seed, and `console.log(wallet)` printed the phrase. The conformance chain suite now walks every property reachable from a manager and an account and fails if a key, the seed or the phrase is found. Manager constructors take `string | Uint8Array | Signer`.
