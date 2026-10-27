# @anywalletkit/wallet-evm

## 0.3.1

### Patch Changes

- b1350b4: Every type a public signature uses is exported, so the API reference documents it and apps can name it: the provider config types (`LifiSwap2Config`, `BalancerSwap2Config`, `NearIntentsSwap2Config`, `FyndSwap2Config`, …), the explorer client options in history-evm (`EtherscanClientOptions`, `AlchemyClientOptions`, `BlockscoutClientOptions`), `Swap2ExecutionPhase`, the Omniston client shapes, and the row / view types the chain packages already expose through their methods. Type-only additions, plus the account-meta role constants of native SOL staking (`READONLY`, `WRITABLE`, …). Renames on export: Aave and Morpho activity `Action` → `AaveActivityAction` / `MorphoActivityAction`; conformance `ProtocolCtor` / `WriteProtocolCtor`; history-evm `RawRow`.
- eb14cb5: npm metadata: every package has a description and the `anywalletkit` keyword. The LI.FI, NEAR Intents, Omniston and THORChain packages had an empty description, so npm showed the README badge markdown in its place, and 24 packages were missing from a `keywords:anywalletkit` search. `pnpm pack:check` now refuses a package without either.
- Updated dependencies [eb14cb5]
  - @anywalletkit/core@0.6.1

## 0.3.0

### Minor Changes

- f2de8b6: The swap gate checks the order itself and the account. A gasless swap's sheet said "Signed order" without the order, and its pre-approval let any EIP-712 data on the chain through once — another order or a Permit, for any account.
  
  - `SwapApproval.source` for a typed order carries `typedData` (parsed) and `text` (pretty JSON) for the sheet.
  - `GatedOp` `evm-typed-data` requires `typedDataHash` — `typedDataHash(typed)` from `@anywalletkit/wallet-evm` (now exported), the digest the account signs; `planMatchers` compares it (`typedDataMatcher`). A plan whose order cannot be hashed is refused before the sheet opens.
  - `ReviewGate.preApprove(matchers, ttlMs, account)` binds pre-approvals to an account; a bound one passes only an op whose new `account` field names it. `SwapReviewMeta.account` and `EarnReviewMeta.account` are required and `reviewSwapPlan` / `reviewEarnPlan` always bind — pass the account in the ops your reviewed account builds.
  - `@anywalletkit/wallet-evm` is now a dependency of extension-kit.
- 9e4bcd2: EIP-7702 (type 4) transactions are simulated and gas-estimated with their `authorizationList`, so the dry run executes the delegate's code instead of the account's own. A type 4 with `gasPrice` (or on a chain that answers with a legacy gas price) is refused instead of silently becoming a legacy transaction without its authorizations, and an `authorizationList` on a transaction that is not type 4 is refused instead of dropped (`assertTxShape`, exported).

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.
- 9e4bcd2: `describeTransaction` decodes the call inside an EIP-7702 (type 4) transaction. It returned only the delegation, so an `approve(spender, max)` riding in the calldata showed no spender, amount or `approve-unlimited` warning. The kind stays `eip7702-delegation`; the new `call` field says what the call is, and its token / spender / amount fields and warnings are filled as for any transaction.
- 9e4bcd2: `describeTypedData` reads more of what dApps send: a hex domain `chainId` (it was dropped, and with it the chain-mismatch warning); Permit2 SignatureTransfer messages (`PermitTransferFrom` / `PermitBatchTransferFrom`, amounts under `permitted`) are flagged `approve-unlimited` at the max amount like AllowanceTransfer ones; a DAI-style permit (`holder`, `expiry`, `allowed`) is a `permit` — `allowed: true` an unlimited approval, `allowed: false` a revoke, `expiry` 0 no deadline — instead of `generic`.
- 9e4bcd2: Sends from one account go out one at a time. Two `sendTransaction` / `transfer` calls started together both read the `pending` nonce before either was broadcast and signed the same nonce: the second replaced the first or was refused. Prepare → sign → submit now runs in a per-account queue (the nonce floor then covers the next send); a failed send does not block the next.
- eec3745: `isUnlimitedAmount` (and so `describeTransaction` / `describeTypedData`'s `approve-unlimited`) uses the SDK-wide threshold, type(uint128).max: `approve(spender, 2^255 − 1)` and Permit2's uint160 max were described as bounded approvals.
- Updated dependencies [f743c06]
- Updated dependencies [f743c06]
- Updated dependencies [d82e140]
- Updated dependencies [f743c06]
- Updated dependencies [398129f]
  - @anywalletkit/core@0.6.0

## 0.2.0

### Minor Changes

- b08c01a: `getTokenInfo(address)`: an ERC-20's decimals, symbol, name and total supply read from the contract (`bytes32` symbols decoded, strict UTF-8, no `TextDecoder`), and `upgradeable` when it sits behind an EIP-1967 / EIP-1822 / beacon / ZeppelinOS proxy. No code, an EIP-7702-delegated account or no `decimals()` throws `NotATokenError`; RPC failures are not mistaken for "not a token".

### Patch Changes

- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.1.6

### Patch Changes

- 8aa911d: `policies.maxFee` reaches `approve` (EVM) and `sendSerialized` (Solana) too. It reached only `sendTransaction`, `signTransaction` and `transfer`; an approval or a provider-built Solana transaction paid whatever fee it carried. The kit now hands those two the tightest cap as `WriteOptions.maxFee` (second argument of `approve`, third of `sendSerialized`; a tighter caller cap stays), and the accounts hold it on what they sign: wallet-evm's `approve(options, writeOptions?)` passes it to each transaction it sends (the USDT reset too), wallet-solana's `sendSerialized(base64, guard, options?)` checks the proven fee against the tighter of `transactionMaxFee` and `options.maxFee`. The kit README now lists which writes the cap covers, and no longer calls raw `approve(spender, 0)` a revoke. Audit 2026-10-25 (post-release), L2.
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.1.5

### Patch Changes

- 80d6451: `verifyTypedData` accepts the signatures `signTypedData` makes when the domain `chainId` is a string. Signing normalised `"0x89"` / `"137"` to the number 137 before hashing (so `chainId` is part of the domain, as a verifying contract computes it), while verifying hashed the domain as given — the account's own signature did not verify. Both now use one `typedDataHash()`. Audit 2026-10-25, #1.6.
- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: No signing account outlives `WalletManager.dispose()`. Every chain manager awaited between its cache check and storing the account, so: an account whose build was in flight during `dispose()` was created afterwards with a live key (a child derived from an injected seed signer kept signing); concurrent `getAccount` calls for one path built two accounts and leaked the first; a signer-built manager handed out new accounts after `dispose()`. New protected `cachedAccount()` / `signerAccount()` in core build each account once, refuse after dispose, dispose an account finished late and a derived child that never became an account. All seven chain managers use them. `describeChainModule` checks the contract (one account under concurrent calls, none after dispose). Audit 2026-10-25, #3.
- 80d6451: `policies.maxFee` now holds for the transaction that is signed, not only for the quote. The kit compared the cap with `quoteSendTransaction` (an EVM estimate of 21 000 gas) while the account signed its own gas limit with headroom (25 200 gas), so a 22 000 000 wei cap let a 25 200 000 wei transaction through. New `WriteOptions { maxFee }` in core is an optional second argument of `sendTransaction`, `signTransaction` and `transfer`; every chain package checks the tighter of it and its configured `transactionMaxFee` / `transferMaxFee` on what it signs (`feeLimit()` helper), and the kit passes the tightest matching policy cap through it after the quote check. A write whose quote fits but whose signed worst case does not is now refused by the account after `confirm`, with the chain package's own error (EVM: `Error('Exceeded maximum fee cost…')`), not `PolicyViolationError`. Audit 2026-10-25, #4.
- 760ca6e: Security fixes from the 2026-10-25 audit.
  
  - **No second signature on failover.** A lost broadcast answer followed by `already known` from the next RPC now resolves to the hash of the transaction already sent, instead of signing a new one with the next nonce (a double payment). `nonce too low` is re-signed only after the account has checked that the rejected hash is not on the network; when that lookup fails the send ends as `BroadcastUnknownError`. `replacement transaction underpriced` is no longer retried.
  - **The fee cap holds for what is signed.** `transferMaxFee` / `transactionMaxFee` were checked on a network quote while the caller's own `gasPrice` / `maxFeePerGas` was signed. They are now checked on the prepared transaction (gas limit × fee cap) before every signature, in `signTransaction` too, and the balance check uses the same worst-case fee. `quoteSendTransaction` prices the caller's fee fields, so the kit `maxFee` policy sees them. `TransferResult.fee` is that worst-case fee. A caller tip above the network's now lifts the fee cap with it (it used to produce a tip above the cap).
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0

## 0.1.4

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.1.3

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

## 0.1.2

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
- 29af9d6: EIP-712 domain `chainId` sent as a string (hex "0x89" or decimal) is now hashed as a NUMBER. viem includes `chainId` in the EIP712Domain type only for numeric values, so such typed data was signed over a domain without chainId and the verifying contract rejected the signature (Omniston EVM→TON order on Polygon, 2026-10-16: registered, never filled). `WalletAccountEvm.signTypedData` normalizes (and the cross-chain guard now recognizes hex strings), the swap2 engine normalizes before handing typed orders to any signer, and the Omniston provider returns typed data with a numeric chainId.
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
