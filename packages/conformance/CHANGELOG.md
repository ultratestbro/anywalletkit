# @anywalletkit/conformance

## 0.3.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/tx-preview-evm@0.1.3

## 0.3.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1
  - @anywalletkit/tx-preview-evm@0.1.2

## 0.3.0

### Minor Changes

- 4b6d97f: No secret is an object property anywhere. `Wallet` no longer keeps the seed phrase string: it turns the phrase into the 64-byte seed in the constructor, hands each chain manager a copy, and `dispose()` zeroizes it and refuses later calls; `new Wallet(seedBytes)` and managers built from seed bytes are accepted (copied). `LocalSigner` keys and seeds and `WalletManager` seeds live in module WeakMaps, so `console.log`, `JSON.stringify`, `util.inspect` and crash reporters see only public fields; `LocalSigner.toJSON()` is the public view. Accounts get leaf signers (`LocalSigner.leafFromSeed`, `deriveLeaf`) that hold only their own key, never a copy of the master seed. Before: `JSON.stringify(account)` contained the private key and the master seed, and `console.log(wallet)` printed the phrase. The conformance chain suite now walks every property reachable from a manager and an account and fails if a key, the seed or the phrase is found. Manager constructors take `string | Uint8Array | Signer`.
- 6568e08: Renames: the base of every swap2 error is now `Swap2Error`; the pinned derivation vectors are exported as `derivationVectors` and shipped as `vectors/derivation.json` (values unchanged). The approvals module drops its policy-engine rule set and its `Policy` / `PolicyRule` / `PolicyContext` types — the kit's policies treat revokes as `kind: 'revoke'` on their own; `isRevokeCalldata` and `isUnlimitedAmount` stay. THORChain's default `clientId` is `anywalletkit`.
- 6a78e14: New provider `@anywalletkit/protocol-swap2-jupiter`: same-chain Solana swaps through Jupiter's Swap API V2 Router path (`GET /swap/v2/build`, Metis routing, no Jupiter swap fee; keyless at 0.5 RPS or an `apiKey` sent as `x-api-key`). Nothing from the API is used unchecked: only Jupiter v6 and token / system / ATA / compute-budget instructions, the taker as the only signer, no tip, and the swap instruction's own arguments (`route_v2` / `shared_accounts_route_v2`) decoded — input amount, quoted output, slippage and a zero platform fee must equal the request. The v0 transaction is assembled locally with the response's lookup tables; the compute budget is ours (limit = 1.2× a simulation when `rpcUrls` is given, price capped by `maxComputeUnitPrice`). The account executes it through its serialized-transaction guard and its own RPC.
  
  `wallet-solana`: the serialized-transaction guard counts the wallet's own wrapped-SOL token accounts as its SOL. Aggregator routes close the wallet's wSOL account, which also unwraps wSOL the wallet already held; that used to be refused as a token drain (live 2026-10-23: every large mainnet wallet probed held some wSOL), and a SOL output could not tell the wallet's own unwrapped wSOL from swap proceeds — now both are exact.
  
  `conformance`: `createMockAccount({serialized: true})` exposes swap2's `sendSerializedTransaction` hook; the swap2 behaviour suite checks serialized legs (the fixture's `serialized` decoder must accept what would be signed, and the account must execute exactly the reviewed bytes with the engine's balance expectation).

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [5d7976e]
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
- Updated dependencies [87f9823]
  - @anywalletkit/tx-preview-evm@0.1.1
  - @anywalletkit/core@0.3.0

## 0.2.0

### Minor Changes

- 386615c: `NameResolver` interface (`resolve(name, chain)`, forward-verified `reverse`, `avatar`, `supports`), `NameError` codes, `ResolvedName` with warnings, `nameResolvers([...])` to stack resolvers, `assertNameUnchanged` for the signing-time check, `isNameLike`. Conformance gains `namesSuite`.
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
  - @anywalletkit/tx-preview-evm@0.1.0
