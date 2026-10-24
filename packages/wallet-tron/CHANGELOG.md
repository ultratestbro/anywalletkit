# @anywalletkit/wallet-tron

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
