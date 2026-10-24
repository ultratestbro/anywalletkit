# @anywalletkit/wallet-zcash

## 0.2.1

### Patch Changes

- 4b6d97f: No secret is an object property anywhere. `Wallet` no longer keeps the seed phrase string: it turns the phrase into the 64-byte seed in the constructor, hands each chain manager a copy, and `dispose()` zeroizes it and refuses later calls; `new Wallet(seedBytes)` and managers built from seed bytes are accepted (copied). `LocalSigner` keys and seeds and `WalletManager` seeds live in module WeakMaps, so `console.log`, `JSON.stringify`, `util.inspect` and crash reporters see only public fields; `LocalSigner.toJSON()` is the public view. Accounts get leaf signers (`LocalSigner.leafFromSeed`, `deriveLeaf`) that hold only their own key, never a copy of the master seed. Before: `JSON.stringify(account)` contained the private key and the master seed, and `console.log(wallet)` printed the phrase. The conformance chain suite now walks every property reachable from a manager and an account and fails if a key, the seed or the phrase is found. Manager constructors take `string | Uint8Array | Signer`.
- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.2.0

### Minor Changes

- e0edbf6: New chain package: Zcash transparent accounts (BIP-44 `m/44'/133'/0'/0/i`, `t1…`). v5 transactions (ZIP-225) with ZIP-244 txids and signature hashes — verified against mined mainnet transactions (round-trip, txid, every on-chain signature) — ZIP-317 conventional fees with own coin selection, ZIP-203 expiry (40 blocks) and anti-fee-sniping lock time, the consensus branch id picked from the tip height (NU6.3 today, overridable). Blockchair (public, CORS) and Zcash Blockbook transports with failover; Zcash message signing/verification; activity history over Blockchair. Shielded pools (Sapling/Orchard, unified addresses) are refused by name — transparent only.

### Patch Changes

- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @anywalletkit/core@0.2.0
