# @anywalletkit/networks

## 0.2.5

### Patch Changes

- Updated dependencies [6dde4e4]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0

## 0.2.4

### Patch Changes

- 8aa911d: Audit 2026-10-25 (post-release), low findings L3–L7:
  
  - **backup-cloud (L3).** `iCloudKeychain().getOrCreate` runs one call at a time per keychain item, process-wide. Two at once (a double tap on "back up") both saw no key, both created one, and the second overwrote the key the first backup had just been sealed with, so that file no longer opened without its password. Each caller still gets its own copy of the key.
  - **keyring (L4).** `importMnemonic(phrase, { adoptId })` reads the id once and requires it to hold this phrase and passphrase (`{"type":"mnemonic",…}`). Before, the source took the id unread: the accounts' addresses came from the phrase passed in, while signatures used whatever the id held. A missing, different or unreadable secret is refused with `invalid-input`; a bad or taken id and a phrase already in the keyring are refused before that read (no prompt).
  - **extension-kit (L5).** `Vault.addPasskey` is refused (`invalid-input`) while the vault holds no secret. With nothing to prove the DEK against, any 32 bytes were sealed under the passkey, and every later passkey unlock handed out that wrong key.
  - **core (L6).** `assertNameUnchanged` compares addresses without case only on `eip155:*`. On other chains a case variant of a base58 address is another key, and it passed as "unchanged".
  - **networks (L7).** `rpcUrlsForSync` / `usesUserRpcSync` throw `NetworkError('not-loaded')` before `load()`. They answered from the builtin table, so a client built at cold start used public RPCs the user had turned off (`onlyOwnRpc`), and the review sheet called the RPC not custom. `listSync` / `getSync` still answer builtin-only before `load()`. A failed storage read no longer counts as an empty table: `load()` rejects and stays retryable, and no write runs on top of it (the next write used to replace the user's stored RPCs).
- @anywalletkit/swap2-assets@0.1.5

## 0.2.3

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: `NetworksTable` writes made at once all land. Every write read the state, awaited, and saved a copy of what it had read, so with an asynchronous storage (AsyncStorage, `chrome.storage`) two writes at once (two `addRpc`, two `markRpc` after a verification round) lost one; `addRpc` / `removeRpc` read and wrote in two separate steps. Each write is now one serialized read → change → save, and memory changes only after the storage accepted the write. Audit 2026-10-25, #1.7.
- Updated dependencies [07db4c1]
- Updated dependencies [a9a5e0a]
  - @anywalletkit/swap2-assets@0.1.5

## 0.2.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/swap2-assets@0.1.4

## 0.2.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/swap2-assets@0.1.3

## 0.2.0

### Minor Changes

- a17a31c: New package `@anywalletkit/networks`: one table of networks for every wallet build. The catalog mainnets (30 EVM chains plus Solana, TON, Tron, Bitcoin, NEAR, Zcash) with the public RPC failover lists the mobile app and the extension used to keep separately; default testnets for every family (Sepolia, Base / Arbitrum / OP Sepolia, Polygon Amoy, BSC testnet, Monad testnet, Solana devnet, Bitcoin testnet4, TON testnet, Tron Nile, NEAR testnet, Zcash testnet), shipped disabled; `NetworksTable` over any `JsonStorage` (AsyncStorage, chrome.storage, memory) — user RPCs are prepended to a builtin list, builtins cannot be deleted, `onlyOwnRpc` drops the public fallback, custom networks have none, a user RPC whose check failed is parked with the reason; `verifyNetwork` per family (EVM `eth_chainId`, Solana `getGenesisHash`, TON config param 19 global id, Tron genesis block id, BTC / Zcash genesis over Esplora / Blockbook / Blockchair, NEAR `status.chain_id`) with latency and tip; the URL policy (https only, `http://` for private addresses behind the explicit opt-in); `parseAddChainParams` (EIP-3085) lifted from the extension kit with the site origin recorded as the network's source.

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [e4083a3]
  - @anywalletkit/swap2-assets@0.1.2
