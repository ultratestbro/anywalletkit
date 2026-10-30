# @anywalletkit/wallet-tron

## 0.6.1

### Patch Changes

- 7d8eaa1: `createTronHistory().listActivity` no longer spins forever on a malformed TronGrid answer. Every row's `block_timestamp` is checked when its page arrives: it must be a non-negative safe integer (a transaction row without one still counts as 0, as before), and a `data` field that is not a list is refused; anything else fails the call with `HistoryUnavailableError(chain, '… malformed block_timestamp')`. The merge loop also fails the call if a pass consumes no row. Honest TronGrid pages read as before.

## 0.6.0

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

## 0.5.0

### Minor Changes

- 012a296: Contract-call parameters encode to exactly one 32-byte word each, and must match the `functionSelector` signature in count and type (new export `encodeCall`). `uintN` / `intN` are range-checked for N (negative `uint` refused) and take a bigint, a safe integer or a decimal / `0x` string (no whitespace, `0b`, `0o`); `bytes32` is at most 32 bytes of even-length hex; `bool` must be `true` or `false`; `address` must be a string. Before, a `bytes32` or an oversized uint could emit several words and shift every argument after it, so the contract decoded other arguments than the ones the policies read.
- a72efa7: Tron `signRaw` runs what `prepare()` runs for the wallet's own builds. With a provider, the reference block must be a block of the configured network (`/wallet/getnowblock` + `/wallet/getblockbynum`, code `ref-block-mismatch`), also for node builds and prebuilt `sendTransaction` input; offline, a non-mainnet account refuses to sign unless the new config `allowOfflineTestnetSigning` is set (code `offline-network`). Under a fee cap, the bytes are priced (fee_limit + bandwidth, memo and activation fees) and refused above the cap, a contract call without `fee_limit` is refused, and so is any transaction without a provider to price it. `raw_data.data` above 512 bytes is refused (code `memo`). For contract types without a schema, a JSON copy that names a payment field (`to_address`, `amount`, `contract_address`…) is `raw-mismatch`. In the kit, the `signRaw` intent's `to`, `amount` and `token` are read off `raw_data_hex` (TransferContract, TRC-10, TRC-20 calls), never the JSON copy.

### Patch Changes

- 4df03a5: The internal signing helpers (BTC `signPlan` / `signInputs` / `signSpend`, Zcash `signInputs` / `signSpend`, EVM `signHash` / `signPrepared` / `signAndBroadcast`, NEAR `signBytes`, Solana `signChecked` / `signPlan`, TON `signMessages`, Tron `signDigest`) are `#private` methods. They were private only in TypeScript, so code holding an account could call them at runtime and skip the checks the public methods run on what they sign.

## 0.4.1

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.4.0

### Minor Changes

- 143065c: The fee cap now holds for what a Tron transaction may really burn: its `fee_limit` of energy plus the bandwidth, memo and activation fees `fee_limit` does not cover must stay within the tighter of `transactionMaxFee` / `transferMaxFee` and `WriteOptions.maxFee` (`UnsafeTransactionError` `fee-limit` otherwise). The `fee_limit` the SDK derives for its own contract calls is capped by that cap, and `signRaw` takes `WriteOptions` and checks `fee_limit` against them. `signRaw` keeps signatures already on the transaction (a multisig co-signer's) and adds its own once, instead of replacing them.

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.3.2

### Patch Changes

- a817739: `signRaw`, `sendTransaction` and `signTransaction` refuse an `AccountPermissionUpdateContract` (it can hand the account's keys to someone else) unless `allowPermissionChanges: true`, and refuse contract types the wallet cannot decode unless `allowUndecodedContracts: true` (`VoteWitnessContract`, which only re-assigns votes, is still signed). New `UnsafeTransactionError` codes: `permission-change`, `undecoded-contract`.
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.3.0

### Minor Changes

- 80d6451: Tron history no longer loses transactions that share a block timestamp. Pages were time windows (`max_timestamp`) plus the txIDs already emitted at the edge; with more rows at one timestamp than `limit`, the next request returned the same rows, all skipped, and the listing ended. Each TronGrid list is now read along its own `meta.fingerprint`, a timestamp's rows are merged from both lists by txID, and a timestamp that does not fit in a page is resumed inside it. The cursor format changes to `{ v: 2, n, s: { tx, trc20 }, t?, g? }` (`n`, the API page size the positions belong to, is kept for the whole listing whatever `limit` later pages ask); a fingerprint the API does not advance ends that list instead of looping, and more than 500 pages of one list in one call fail with `HistoryUnavailableError` instead of shortening the list; a v1 cursor from an earlier version is refused (start the listing again). A page also knows when it is the last one (no cursor). Audit 2026-10-25, #1.5.

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: No signing account outlives `WalletManager.dispose()`. Every chain manager awaited between its cache check and storing the account, so: an account whose build was in flight during `dispose()` was created afterwards with a live key (a child derived from an injected seed signer kept signing); concurrent `getAccount` calls for one path built two accounts and leaked the first; a signer-built manager handed out new accounts after `dispose()`. New protected `cachedAccount()` / `signerAccount()` in core build each account once, refuse after dispose, dispose an account finished late and a derived child that never became an account. All seven chain managers use them. `describeChainModule` checks the contract (one account under concurrent calls, none after dispose). Audit 2026-10-25, #3.
- 8541692: Fixes from the 2026-10-25 audit: timeouts, failover and exact amounts.
  
  - **wallet-tron, wallet-near: timeouts.** Url providers had no timeout, so a node that never answered hung every call and failover never ran. Each request now times out after the new `timeoutMs` option (default 15 000; `AbortSignal.timeout`, or a timer on runtimes without it) and the next provider is tried.
  - **wallet-tron: broadcast outcome.** A broadcast without an answer is re-sent as the same signed bytes to the next provider, `DUP_TRANSACTION_ERROR` counts as accepted (it used to be reported as a failure, inviting a second transaction), and when no node answers the new `BroadcastUnknownError` (`maybeSent`, `hash` = txID) is thrown.
  - **wallet-near: broadcast outcome.** `send_tx` is never re-sent to another RPC; without a definitive answer (no response, a node timeout) it throws the new `BroadcastUnknownError` with the locally computed hash. Definitive refusals stay clean errors.
  - **wallet-tron: exact sun.** Balances went through `JSON.parse` and `Number()`, rounding above 2^53. Url providers now keep big integers exact; a custom transport that hands over an unsafe number is refused with a clear error, and a TRX transfer above 2^53 − 1 sun is refused before the node builds it.
  - **Lido, SSV, Tonstakers, Mellow:** their REST reads (APR, rewards, queue times, stats) time out after 15 s instead of hanging.
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

- 0d68fda: New provider `@anywalletkit/protocol-swap2-chainflip`: Chainflip vault swaps (native BTC / ETH / SOL / TRX, USDC / USDT) from Ethereum, Arbitrum and Tron into Ethereum, Arbitrum, Solana, Tron and Bitcoin through Chainflip's public backend (no broker account, 0 bps). The encoder's output is decoded and checked before anything is signed (vault, destination chain / asset / address, amount, refund = sender, min price ≥ ours, no DCA / boost / broker fee / affiliates); fill-or-kill refunds to the sender. Tron sources are a TRC-20 transfer to the Vault with the swap as a binary note, so `UnsignedTx.memoEncoding` (`"utf8"` default, `"hex"`) is new in swap2-core and `wallet-tron` accepts `memoEncoding` on transfers and contract calls (`memoBytes` exported).
- 488cf6d: Node-built transactions are checked against the request before they are simulated, priced or signed (scan F7). After `/wallet/createtransaction` and `/wallet/triggersmartcontract` the bytes must be exactly one contract of the requested type owned by this account — TransferContract: recipient and amount; TriggerSmartContract: contract address, calldata (`selector ‖ parameters`), call value and the `fee_limit` the wallet posted — with no Permission_id, no TRC-10 token on the call, no second contract and no field a build never carries; the memo the wallet splices in must be exactly the requested bytes in the requested encoding. A mismatch throws `UnsafeTransactionError('build-mismatch')`. This also applies to `quoteTransfer` / `quoteSendTransaction` / `estimateFee`, which build through the node. New export: `assertNodeBuild`.
- e53a9c0: `signRaw` and every prebuilt-transaction path now verify the bytes before anything is shown or signed: `raw_data_hex` is required, `txID` must equal `sha256(raw_data_hex)` (`txid-mismatch`), the JSON `raw_data` must agree with the bytes field by field (`raw-mismatch`), and the hard checks run on the decoded bytes. `describeTransaction` describes the bytes, not the JSON (`no-raw-hex` / `raw-undecodable` / `undecoded` / `account-permission` / `multi-contract` warnings). New: `decodeRawData`, `encodeRawData`, `verifyRawTransaction`, `rawMismatch`, `readFields`, `CONTRACT_TYPES`; `trc10-transfer` kind. Closes the blind-signing hole where a dApp could show one transaction and have another signed (SDK-142 C1).

### Patch Changes

- 4b6d97f: No secret is an object property anywhere. `Wallet` no longer keeps the seed phrase string: it turns the phrase into the 64-byte seed in the constructor, hands each chain manager a copy, and `dispose()` zeroizes it and refuses later calls; `new Wallet(seedBytes)` and managers built from seed bytes are accepted (copied). `LocalSigner` keys and seeds and `WalletManager` seeds live in module WeakMaps, so `console.log`, `JSON.stringify`, `util.inspect` and crash reporters see only public fields; `LocalSigner.toJSON()` is the public view. Accounts get leaf signers (`LocalSigner.leafFromSeed`, `deriveLeaf`) that hold only their own key, never a copy of the master seed. Before: `JSON.stringify(account)` contained the private key and the master seed, and `console.log(wallet)` printed the phrase. The conformance chain suite now walks every property reachable from a manager and an account and fails if a key, the seed or the phrase is found. Manager constructors take `string | Uint8Array | Signer`.
- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- 7b580c9: A prebuilt transaction whose schema-less contract type (`AccountPermissionUpdateContract`, `CreateSmartContract`, …) repeats `owner_address` is refused as non-canonical.
  
  The decoder read the first occurrence and java-tron reads the last. A signature that every check attributed to this wallet could therefore act on another account where its key holds permission weight.
- 0153750: `verifyRawTransaction` no longer refuses every node-built or dApp transaction of a contract type the wallet has no schema for (VoteWitnessContract `votes`, AccountCreateContract `account_address` …) as `raw-mismatch`: for those types only the type and the owner are compared with the bytes, and `describeTransaction` says once that the type is not decoded (its parameters are not shown and the JSON copy of them is not trusted) instead of listing every parameter field. Types the wallet decodes but has no summary for (delegation, withdrawals …) are described with their decoded fields instead of "no decoder". A 355-transaction mainnet corpus fixture is verified in the tests.
- ca12d09: The Tron protobuf reader is now strict and canonical (scan F4): tags longer than 5 bytes or ≥ 2^32, non-minimal varints (tags, values, lengths), varints over 64 bits and repeated singular fields are refused as `raw-noncanonical`; a contract with a schema (transfers, TRC-10, TriggerSmartContract, stake v1/v2, delegation) must decode completely — an unknown field is a hard `raw-undecodable` — and must re-encode to exactly its `Any.value` bytes. Unknown fields in the `Contract` wrapper or the `Any` are refused. int64 values are decoded as signed (a 10-byte varint ending in 0x01 is a valid negative). Closes a gap where java-tron, which keeps only the low 32 bits of a tag, could read a hidden field the sheet showed as "not decoded". New exports: `NonCanonicalError`, `isDecodedContractType`.
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
