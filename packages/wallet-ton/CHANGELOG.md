# @anywalletkit/wallet-ton

## 0.4.0

### Minor Changes

- 1b249be: Jetton `transfer()` refuses a `responseDestination` other than the wallet itself (`UnsafeTransactionError` code `foreign-response-destination`) unless the new option `allowForeignResponseDestination` is set, and refuses attaching more than `maxJettonAttachedValue` nanotons (new config, default 1 TON, `forwardTonAmount` included; code `attached-value`). Both received TON that the caller's recipient check never saw.
- 9419c27: A message's `bodyBoc` is signed only when it is a plain single-root BoC (`UnsafeTransactionError` code `non-canonical-boc` otherwise): the generic magic, one root, no absent cells, and no cell that stores its hashes (`with_hashes`), has a level mask or is exotic, the layouts another reader may parse differently from @ton/core. The bytes are not required to round-trip: real provider BoCs order their cells differently from @ton/core. A `body` that is neither a string nor a `Cell` is refused (code `body`) instead of being replaced by `bodyBoc`. New exports `canonicalBocCell`, `messageBody`.
- 9df17da: TON addresses are paid only in a strict form: raw `wc:hex` (64 hex digits) or a friendly address with a valid checksum. wallet-ton refuses anything else with `UnsafeTransactionError` code `address`; @ton/core alone also accepted `'+0:…'`, `' 0:…'`, `'0.0:…'` and `'0:…:x'` as `0:…`. In the kit, a TON destination in any other spelling makes the write `destinationUnknown`, so a blocklist cannot be dodged with one.

### Patch Changes

- 4df03a5: The internal signing helpers (BTC `signPlan` / `signInputs` / `signSpend`, Zcash `signInputs` / `signSpend`, EVM `signHash` / `signPrepared` / `signAndBroadcast`, NEAR `signBytes`, Solana `signChecked` / `signPlan`, TON `signMessages`, Tron `signDigest`) are `#private` methods. They were private only in TypeScript, so code holding an account could call them at runtime and skip the checks the public methods run on what they sign.

## 0.3.1

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- 5392d40: `@noble/curves` is a dependency. The read-only account imports `@noble/curves/ed25519.js` at runtime, but the package listed it only under `devDependencies`, so an app that did not install it itself (or get it hoisted from another package) failed with "Cannot find module '@noble/curves/ed25519.js'" on import. `pnpm pack:check` now refuses any package whose shipped JavaScript imports a package it does not declare as a dependency, peer or optional dependency.
- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.3.0

### Minor Changes

- 143065c: A broadcast with no definitive answer (no response, a timeout, a non-JSON body such as a proxy's HTML 502) now throws `BroadcastUnknownError` (`maybeSent: true`, `hash` = the signed body hash) instead of a plain `NetworkError`: the message may be on chain, and signing again would use the next seqno and pay twice. A node's explicit refusal (`ok: false`) stays a `NetworkError`; with several endpoints, the error is a refusal only when every one refused. New `isAnsweredRefusal(error)`; a custom `TonRpc` should mark node refusals `answered: true`, otherwise its failures count as "maybe sent".
- 143065c: Send modes that drain the wallet — 128 (the whole remaining balance) and 32 (the account destroyed once empty) — are now refused locally, before any seqno or emulation, unless `allowDrainingTransactions` is set; before, only a tonapi emulation reporting the risk caught them, so `simulate: false` signed them. Prebuilt signed bodies are checked too. `describeTransaction` shows each message's `mode` and warns `carries-all-balance` / `destroys-account`. A jetton transfer's recipient and response destination now get the network (test-only flag) and workchain checks a native transfer has.

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- f743c06: `WalletManagerTon.fromTonMnemonic` (and so `Keyring.importTonMnemonic`) checks the phrase with @ton/crypto's `mnemonicValidate`. Any 24 words were taken: a typo, or a BIP-39 phrase pasted into the TON-mnemonic import, opened a different, empty wallet. Such a phrase is now refused ("Not a valid TON mnemonic").
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.2.5

### Patch Changes

- 2d9fe4b: One external ed25519 key registered for several chains can no longer be made to sign another chain's transaction as a "message": TON and NEAR `sign()` refuse bytes that carry the account's public key (a Solana transaction names its signer's key), and Solana `sign()` on an external signer refuses 32-byte messages (a TON or NEAR transaction digest). TON Connect `signData` binary payloads accept whitespace in their base64, as `atob` does, and a non-integer `workChain` is refused.
- f08b92f: No signing path around the policies: the policy wrapper hides the account's `signer`, wraps accounts its methods return (NEAR's `withAccountId`) with the same policies, and `wallet.getManager(chain)` now hands out guarded accounts (`getAccount`, `getAccountByPath`, `getNamedAccount`) and hides the manager's seed and signer accessors. The internal helpers that sign in wallet-btc, wallet-zcash and wallet-ton are named `sign*` (`signSpend`, `signPlan`, `signMessages`), so the kit guards them like every other signing method.
- a354990: TON and NEAR `sign()` refuse a 32-byte message with `MessageIsTransactionError`: both chains sign transactions over a 32-byte digest (the V5R1 signing-cell hash, sha256(borsh(tx))), so a "message" of those bytes was a valid transaction signature the policies treated as harmless. TON accounts gain `signTonProof` and `signTonConnectData`, which build the TON Connect digests from the request and their own address; the kit treats both as message signatures. extension-kit's `tonProofMessage` / `tonSignDataMessage` are documented as verification helpers.
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.2.4

### Patch Changes

- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.2.3

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: No signing account outlives `WalletManager.dispose()`. Every chain manager awaited between its cache check and storing the account, so: an account whose build was in flight during `dispose()` was created afterwards with a live key (a child derived from an injected seed signer kept signing); concurrent `getAccount` calls for one path built two accounts and leaked the first; a signer-built manager handed out new accounts after `dispose()`. New protected `cachedAccount()` / `signerAccount()` in core build each account once, refuse after dispose, dispose an account finished late and a derived child that never became an account. All seven chain managers use them. `describeChainModule` checks the contract (one account under concurrent calls, none after dispose). Audit 2026-10-25, #3.
- 80d6451: `policies.maxFee` now holds for the transaction that is signed, not only for the quote. The kit compared the cap with `quoteSendTransaction` (an EVM estimate of 21 000 gas) while the account signed its own gas limit with headroom (25 200 gas), so a 22 000 000 wei cap let a 25 200 000 wei transaction through. New `WriteOptions { maxFee }` in core is an optional second argument of `sendTransaction`, `signTransaction` and `transfer`; every chain package checks the tighter of it and its configured `transactionMaxFee` / `transferMaxFee` on what it signs (`feeLimit()` helper), and the kit passes the tightest matching policy cap through it after the quote check. A write whose quote fits but whose signed worst case does not is now refused by the account after `confirm`, with the chain package's own error (EVM: `Error('Exceeded maximum fee cost…')`), not `PolicyViolationError`. Audit 2026-10-25, #4.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0

## 0.2.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.2.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

## 0.2.0

### Minor Changes

- 4fcb9b6: TON deposits with a memo: `transfer({memo})` on a TON account sends it as the jetton forward-payload comment (TEP-74) or the native message comment (memo + forwardPayload together is refused), and swap2-core now executes TON jetton deposits that carry a memo through that surface, like Tron and NEAR token deposits — before, they were refused as not implemented.
- 9cb2e4d: `network: 'testnet'` now uses the testnet wallet_id (network_global_id -3), as Tonkeeper and @ton/ton do. Mainnet addresses are unchanged.
  
  - **What changes:** a testnet wallet gets its own address, and the externals it signs are no longer valid on mainnet.
  - **What it fixed:** before, testnet reused the mainnet wallet_id (-239). Any testnet send could be replayed on a mainnet wallet with the same seqno.
  - **Refused config:** a `walletId.networkGlobalId` that contradicts `network` is refused (`UnsafeTransactionError` with code `network-mismatch`).

### Patch Changes

- 5d7976e: Security audit 2026-10-13 fixes that had stayed on a side branch: Solana provider-tx guard refuses System Assign/Allocate, Token Batch and undecodable core instructions and checks ownership/authority in the post-state (F1, F2); tx-preview flags native value to unlabeled contracts and unverified token symbols (F5); approvals gets a strict `isRevokeCalldata` and a new `isRevokeTransaction` (F8); kit `applyPolicies` resolves or refuses an unknown EVM chain (F4); NEAR caps token storage deposits (F12); TON checks the jetton wallet's owner and master (F13); EVM signing detects the chain before the mismatch check and strips EIP-712 array types linearly (F16, F17); near-intents strips control characters from logs (F18).
- 4b6d97f: No secret is an object property anywhere. `Wallet` no longer keeps the seed phrase string: it turns the phrase into the 64-byte seed in the constructor, hands each chain manager a copy, and `dispose()` zeroizes it and refuses later calls; `new Wallet(seedBytes)` and managers built from seed bytes are accepted (copied). `LocalSigner` keys and seeds and `WalletManager` seeds live in module WeakMaps, so `console.log`, `JSON.stringify`, `util.inspect` and crash reporters see only public fields; `LocalSigner.toJSON()` is the public view. Accounts get leaf signers (`LocalSigner.leafFromSeed`, `deriveLeaf`) that hold only their own key, never a copy of the master seed. Before: `JSON.stringify(account)` contained the private key and the master seed, and `console.log(wallet)` printed the phrase. The conformance chain suite now walks every property reachable from a manager and an account and fails if a key, the seed or the phrase is found. Manager constructors take `string | Uint8Array | Signer`.
- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.1.1

### Patch Changes

- 82464d8: `WalletManager` keeps the 64-byte seed, never the mnemonic string: a phrase passed to a constructor is stretched there and dropped (strings cannot be zeroized, `Uint8Array`s can). Chain managers read it through `seedBytes()`; the base `dispose()` zeroizes it.
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
