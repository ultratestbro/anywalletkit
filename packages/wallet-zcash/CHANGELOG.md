# @anywalletkit/wallet-zcash

## 0.5.0

### Minor Changes

- 834c24d: A protocol module can no longer reach the private key. On a `Wallet` without `policies`, `getProtocol` handed the module the raw account, and `account.signer.key()` — private in TypeScript only — returned the 32-byte key, a copy of which outlived `dispose()`. Three layers now close it:
  
  - `kit`: a module always gets the restricted account. Without policies it is a wrapper with no rules: no limits, but the signer, internal helpers and the account's settings stay out of reach, as they did with `policies: {}`.
  - `core`: `LocalSigner` reads its key through a function of the module, not a method: nothing outside `@anywalletkit/core` can call it.
  - every chain account keeps its signer in a private field (`#signer`). The new `signerKind` field (`'seed' | 'key' | 'external'`) says what holds the key.
  
  **Breaking:** chain accounts (`WalletAccountEvm`, `WalletAccountSolana`, `WalletAccountTon`, `WalletAccountTron`, `WalletAccountBtc`, `WalletAccountNear`, `WalletAccountZcash`) no longer have a `signer` property, the app's own accounts included. Read `account.signerKind` instead of `account.signer.kind`; keep a reference to the `Signer` you injected if you need it.
  
  **Breaking:** a protocol module registered on a wallet without policies gets the policy wrapper instead of the raw account: it is a different object from `wallet.getAccount(chain)`, and writes through it are refused when they sign on another network than the module's chain.
  
  **Breaking:** `LocalSigner` has no `key()` method at runtime any more (it was private in TypeScript).

### Patch Changes

- Updated dependencies [834c24d]
  - @anywalletkit/core@0.7.0

## 0.4.0

### Minor Changes

- b8a91d6: Solana: `decodeStakeInstruction` no longer guesses an `AuthorizeChecked`, `AuthorizeCheckedWithSeed` or `InitializeChecked` layout when the account that decides it (the Clock or Rent sysvar slot) is unresolved, e.g. loaded from an address lookup table: the new authority (or staker / withdrawer) is left undefined, so the stake guard refuses (`sets-authority`) instead of reading the wallet's own slot as the new authority; the kit marks such an instruction `destinationUnknown`. Zcash: `decodeAddress` refuses an address carrying whitespace or an invisible character (U+FEFF, NBSP…) instead of trimming it, and the kit compares Zcash addresses exactly (base58 is case-sensitive) and marks a recipient that is not plain base58 `destinationUnknown`.

### Patch Changes

- 4df03a5: The internal signing helpers (BTC `signPlan` / `signInputs` / `signSpend`, Zcash `signInputs` / `signSpend`, EVM `signHash` / `signPrepared` / `signAndBroadcast`, NEAR `signBytes`, Solana `signChecked` / `signPlan`, TON `signMessages`, Tron `signDigest`) are `#private` methods. They were private only in TypeScript, so code holding an account could call them at runtime and skip the checks the public methods run on what they sign.

## 0.3.1

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.3.0

### Minor Changes

- 143065c: A broadcast with no definitive answer (fetch threw, a timeout, a 5xx, an unreadable body such as a proxy's HTML 502) now throws `BroadcastUnknownError` (`maybeSent: true`, `hash` = the txid computed before sending). Blockchair used to call such a 502 "Broadcast rejected", a final verdict. A node's refusal (an error it gave, with a 4xx or a 200) stays an error, marked answered (`isAnsweredRefusal`). In failover, a refusal after an endpoint that never answered is "maybe sent". "Already in the mempool / block chain" returns the txid.
- 143065c: With the chain tip unknown, a transaction is no longer signed with expiry 0 (never expires): nothing is signed when the expiry, anti-fee-sniping or the branch id need the tip. The expiry is counted from the block the transaction lands in (tip + 1 + `expiryDelta`), and the branch id is the one in force at tip + 1. On testnet and regtest, whose upgrades activate at other heights, `consensusBranchId` must be configured (`UnsafeTransactionError` `unknown-branch-id`).

### Patch Changes

- 143065c: Outputs are matched to the recipient and to the change by script, recipient first. A transfer to oneself and (BTC) a recipient written in uppercase bech32 are no longer refused at signing.
- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.2.6

### Patch Changes

- f08b92f: No signing path around the policies: the policy wrapper hides the account's `signer`, wraps accounts its methods return (NEAR's `withAccountId`) with the same policies, and `wallet.getManager(chain)` now hands out guarded accounts (`getAccount`, `getAccountByPath`, `getNamedAccount`) and hides the manager's seed and signer accessors. The internal helpers that sign in wallet-btc, wallet-zcash and wallet-ton are named `sign*` (`signSpend`, `signPlan`, `signMessages`), so the kit guards them like every other signing method.
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.2.5

### Patch Changes

- 8aa911d: `signTransaction(rawHex)` runs the checks `sendTransaction(rawHex)` runs (prevouts through the client, then `assertSafe`: fee-rate / fee ceiling, change that is not ours, outputs above inputs; then `transactionMaxFee` and `WriteOptions.maxFee`) and returns the bytes unchanged, never re-signed. It returned any hex as-is, so an app that "signs" one hex and broadcasts it elsewhere, or treats `signTransaction` as validation, could release a transaction `sendTransaction` would refuse. It now needs a client, as `sendTransaction(rawHex)` does. Audit 2026-10-25 (post-release), M4.
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.2.4

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

## 0.2.3

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.2.2

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

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
