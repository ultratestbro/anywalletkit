# @anywalletkit/keyring

## 0.3.5

### Patch Changes

- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.3.4

### Patch Changes

- 8aa911d: Audit 2026-10-25 (post-release), low findings L3–L7:
  
  - **backup-cloud (L3).** `iCloudKeychain().getOrCreate` runs one call at a time per keychain item, process-wide. Two at once (a double tap on "back up") both saw no key, both created one, and the second overwrote the key the first backup had just been sealed with, so that file no longer opened without its password. Each caller still gets its own copy of the key.
  - **keyring (L4).** `importMnemonic(phrase, { adoptId })` reads the id once and requires it to hold this phrase and passphrase (`{"type":"mnemonic",…}`). Before, the source took the id unread: the accounts' addresses came from the phrase passed in, while signatures used whatever the id held. A missing, different or unreadable secret is refused with `invalid-input`; a bad or taken id and a phrase already in the keyring are refused before that read (no prompt).
  - **extension-kit (L5).** `Vault.addPasskey` is refused (`invalid-input`) while the vault holds no secret. With nothing to prove the DEK against, any 32 bytes were sealed under the passkey, and every later passkey unlock handed out that wrong key.
  - **core (L6).** `assertNameUnchanged` compares addresses without case only on `eip155:*`. On other chains a case variant of a base58 address is another key, and it passed as "unchanged".
  - **networks (L7).** `rpcUrlsForSync` / `usesUserRpcSync` throw `NetworkError('not-loaded')` before `load()`. They answered from the builtin table, so a client built at cold start used public RPCs the user had turned off (`onlyOwnRpc`), and the review sheet called the RPC not custom. `listSync` / `getSync` still answer builtin-only before `load()`. A failed storage read no longer counts as an empty table: `load()` rejects and stays retryable, and no write runs on top of it (the next write used to replace the user's stored RPCs).
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.3.3

### Patch Changes

- 80d6451: Two `addAccount` calls at once no longer hand out one index twice. The next index was picked before the serialized save, so both calls derived and returned account N, and the second one's name was never stored. The index, the derivation and the save now run in one serialized change (the secret is still read once, outside it), and every add returns the metadata as stored. Audit 2026-10-25, #1.2.
- bf2c90f: Security fixes from the 2026-10-25 audit.
  
  - **kit: policies keyed by namespace apply.** `maxFee` / `allowlist` / `blocklist` rules under a namespace key (`eip155`) were documented to cover every chain of the family and were ignored for `eip155:1`. Rules are now looked up by namespace and by exact id, for the asked-for chain and the account's own: every matching fee cap is checked, a destination must be on every matching allowlist, any matching blocklist refuses. An account whose chain id stays unknown gets its namespace rules; an exact-id rule of its family refuses the write (`policy: 'chain'`), and rules of other families no longer refuse it.
  - **keyring: `removeSource` cannot lose a key.** It deleted the secret before saving the metadata, so a failed save left a source without its secret. The metadata now goes first, with the id in the new `KeyringState.pendingSecretDeletes`; the secret is deleted after, and a failed or interrupted delete is finished by `Keyring.load`. An id still pending cannot be adopted. `SecretStorage.delete` must be idempotent.
  - **keyring: parallel imports.** The duplicate check and the secret write ran outside the serialized state change, so two imports of one phrase at once could both land. They now run inside it; the second import fails with `duplicate`, and a secret written before a failed save is removed again.
- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0

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
