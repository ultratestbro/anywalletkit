# @anywalletkit/keyring

## 0.3.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.3.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

## 0.3.0

### Minor Changes

- f3b164f: New `keyring.exportPrivateKey(accountId, chain)` returns one account's private key on one chain, in the format that chain's wallets import:
  
  | Chain | Format |
  |---|---|
  | EVM | `0x`-hex |
  | Tron | hex |
  | BTC / Zcash | compressed WIF |
  | Solana | base58, 64 bytes (Phantom) |
  | NEAR | `ed25519:…` |
  | TON | 128 hex |
  
  How it works:
  - **Seed accounts:** derived at the chain manager's own path.
  - **Imported keys:** exported on their own chain only.
  - **TON 24-word wallets:** refused, with a pointer to `exportSecret`.
  - **Self-check:** a wallet is built from the key, and its address must equal the account's before anything is returned.
  - **Secret reads:** one.
  
  New `formatPrivateKey()` is the inverse of `parsePrivateKey()`.

### Patch Changes

- 4b6d97f: No secret is an object property anywhere. `Wallet` no longer keeps the seed phrase string: it turns the phrase into the 64-byte seed in the constructor, hands each chain manager a copy, and `dispose()` zeroizes it and refuses later calls; `new Wallet(seedBytes)` and managers built from seed bytes are accepted (copied). `LocalSigner` keys and seeds and `WalletManager` seeds live in module WeakMaps, so `console.log`, `JSON.stringify`, `util.inspect` and crash reporters see only public fields; `LocalSigner.toJSON()` is the public view. Accounts get leaf signers (`LocalSigner.leafFromSeed`, `deriveLeaf`) that hold only their own key, never a copy of the master seed. Before: `JSON.stringify(account)` contained the private key and the master seed, and `console.log(wallet)` printed the phrase. The conformance chain suite now walks every property reachable from a manager and an account and fails if a key, the seed or the phrase is found. Manager constructors take `string | Uint8Array | Signer`.
- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.2.0

### Minor Changes

- e0d5520: `missingChains(accountId)` lists the registered chains a seed account has no stored address for (a chain that joined after the account was created — addresses are computed once at creation), and `completeAddresses(sourceId)` derives and stores them for every account of the source with one secret read. An imported key never has missing chains.
- e0edbf6: `zcash` joins the keyring chains (`m/44'/133'/0'/0/i`, WIF or hex key import) and the conformance vectors (three seeds × five accounts, keys cross-checked with viem, address encoding with Blockchair).

### Patch Changes

- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @anywalletkit/core@0.2.0

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
