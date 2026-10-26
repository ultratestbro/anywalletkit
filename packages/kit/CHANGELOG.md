# @anywalletkit/kit

## 0.4.2

### Patch Changes

- 8286c28: The policies read a transaction's destination from the field the chain package builds it from: Tron is prebuilt only with a `txID` and a contract call only with a `functionSelector` (otherwise a TRX send to `to`); Solana follows wallet-solana's order (wire, compiled `messageBytes` + `signatures`, `{ to, value }`, `instructions`); EVM is `to` only, so a transaction without `to` (a deployment) has an unknown destination. A shape that fits two readings is unknown, so an allowlisted field riding next to a drainer no longer passes the allowlist.
- f08b92f: No signing path around the policies: the policy wrapper hides the account's `signer`, wraps accounts its methods return (NEAR's `withAccountId`) with the same policies, and `wallet.getManager(chain)` now hands out guarded accounts (`getAccount`, `getAccountByPath`, `getNamedAccount`) and hides the manager's seed and signer accessors. The internal helpers that sign in wallet-btc, wallet-zcash and wallet-ton are named `sign*` (`signSpend`, `signPlan`, `signMessages`), so the kit guards them like every other signing method.
- cd8ee9a: Policy keys match their network in any spelling: rules under `solana:mainnet`, `tron:728126428` / `tron:mainnet`, `bitcoin:mainnet` or `eip155:0x1` now apply to accounts that report `solana:5eykt…`, `tron:0x2b6653dc`, `bip122:…`, `eip155:1` (they were silently skipped), and the `bitcoin` namespace covers `bip122`.
- c0f6103: Policy wrappers close the reflective ways around them: the signer is hidden from property descriptors and key listings, writes to a guarded account (methods, settings) are refused, `_config` reads as a frozen copy, and `getManager` exposes only `getAccount`, `getAccountByPath`, `getNamedAccount`, `getReadOnlyAccount`, `getFeeRates` and `basePath`. Under a `maxFee` rule, a `sign*` / `send*` method the policies cannot quote (a chain package's internal helper) is refused. TON and NEAR destinations come only from the field the package builds from (`to`, `receiverId`).
- a354990: TON and NEAR `sign()` refuse a 32-byte message with `MessageIsTransactionError`: both chains sign transactions over a 32-byte digest (the V5R1 signing-cell hash, sha256(borsh(tx))), so a "message" of those bytes was a valid transaction signature the policies treated as harmless. TON accounts gain `signTonProof` and `signTonConnectData`, which build the TON Connect digests from the request and their own address; the kit treats both as message signatures. extension-kit's `tonProofMessage` / `tonSignDataMessage` are documented as verification helpers.
- Updated dependencies [6dde4e4]
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
- Updated dependencies [0d0e46e]
  - @anywalletkit/swap2-assets@0.2.0
  - @anywalletkit/core@0.5.0

## 0.4.1

### Patch Changes

- 8aa911d: History no longer calls a raw `approve(spender, 0)` a revoke when it may be an NFT approval. On an ERC-20 it resets the allowance, on an ERC-721 it APPROVES `spender` for token #0; the policies already read it as an approval, while history wrote "Revoked …", so a user could believe an NFT approval was withdrawn when one was granted. The kit's generic description reads it as a `revoke` only on a known ERC-20 (a transfer marked `erc20`, or the swap2-assets catalog: USDT, USDC…), otherwise as an `approve` of the spender; `approve(0x0, id)` now reads as a `revoke` (it clears an NFT approval). `describeApprovalActivity` returns a `revoke` on a token `tokens` lists with `decimals` above 0 (or a transfer marks `erc20`), an `approve` on a known NFT, and null otherwise so the kit's catalog decides; pass `tokens` with `decimals` to keep the module's labels on ERC-20 revokes. Audit 2026-10-25 (post-release), M5.
- 8aa911d: `policies.maxFee` reaches `approve` (EVM) and `sendSerialized` (Solana) too. It reached only `sendTransaction`, `signTransaction` and `transfer`; an approval or a provider-built Solana transaction paid whatever fee it carried. The kit now hands those two the tightest cap as `WriteOptions.maxFee` (second argument of `approve`, third of `sendSerialized`; a tighter caller cap stays), and the accounts hold it on what they sign: wallet-evm's `approve(options, writeOptions?)` passes it to each transaction it sends (the USDT reset too), wallet-solana's `sendSerialized(base64, guard, options?)` checks the proven fee against the tighter of `transactionMaxFee` and `options.maxFee`. The kit README now lists which writes the cap covers, and no longer calls raw `approve(spender, 0)` a revoke. Audit 2026-10-25 (post-release), L2.
- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1
  - @anywalletkit/swap2-assets@0.1.5

## 0.4.0

### Minor Changes

- 80d6451: A write whose account signs on another network than the one it was asked for is refused before any rule, `confirm` or signature (`PolicyViolationError`, `policy: 'chain'`). With one `eip155` namespace registration whose RPC is on Ethereum, `getAccount('eip155:8453')` handed out the Ethereum account and `confirm` showed Base while the signature was for Ethereum; applying both networks' rules did not prevent it. `applyPolicies` now settles the network first — the account's own (asking `getChainId()` while it still reports `eip155:unknown`) and the `chainId` an EVM transaction carries — and compares; the rules of every network in play apply. Off-chain signatures need no RPC call: messages, and typed data, whose domain `chainId` stays the chain package's to judge (wallet-evm's `allowCrossChainTypedData`); an account with no provider at all (offline signing) is judged by the asked-for chain as before, while a provider that fails fails the write. `Wallet.getAccount` hands out such an account for reads (history and activity across one `eip155` registration keep working) but refuses its writes, with or without policies; it returns the same object for the same account and chain on every call. Short and genesis spellings of one network match (`solana:mainnet` = `solana:5eykt…`, `tron:728126428` = `tron:0x2b6653dc`); the new `sameChain()` is exported. Audit 2026-10-25, #7.
- 80d6451: `policies.maxFee` now holds for the transaction that is signed, not only for the quote. The kit compared the cap with `quoteSendTransaction` (an EVM estimate of 21 000 gas) while the account signed its own gas limit with headroom (25 200 gas), so a 22 000 000 wei cap let a 25 200 000 wei transaction through. New `WriteOptions { maxFee }` in core is an optional second argument of `sendTransaction`, `signTransaction` and `transfer`; every chain package checks the tighter of it and its configured `transactionMaxFee` / `transferMaxFee` on what it signs (`feeLimit()` helper), and the kit passes the tightest matching policy cap through it after the quote check. A write whose quote fits but whose signed worst case does not is now refused by the account after `confirm`, with the chain package's own error (EVM: `Error('Exceeded maximum fee cost…')`), not `PolicyViolationError`. Audit 2026-10-25, #4.
- 80d6451: Raw `approve(spender, 0)` calldata is no longer a revoke to the policy engine. On an ERC-20 it zeroes an allowance, on an ERC-721 it approves `spender` for token #0, and the calldata cannot tell them apart: read as a revoke, it skipped the spender's blocklist entry and the allowlist, so a blocklisted drainer could be granted an NFT through `sendTransaction`. It is now `kind: 'approval'` with the spender as a destination. Any single raw `approve` / `setApprovalForAll(…, true)` call is an approval (amount and `unlimited` read off the calldata; the contract called is checked too), and in a batch their spenders join the destinations. If you use an allowlist, it must now also hold the spenders of raw approve calldata (e.g. Permit2 or a router's approval address), and a swap engine's `approve(spender, 0)` cleanup reaches `confirm` as `kind: 'approval'` with amount 0. Unambiguous revokes are unchanged: `approve({amount: 0})`, `approve(0x0, tokenId)`, `setApprovalForAll(operator, false)`, Permit2 `lockdown`, `revokeDelegation()`. `ApprovalsProtocolEvm.revokeAll` with `batch: true` now revokes ERC-20 through the account's `approve` when it has one, so a blocklisted spender can still be revoked. Audit 2026-10-25, #5.

### Patch Changes

- bf2c90f: Security fixes from the 2026-10-25 audit.
  
  - **kit: policies keyed by namespace apply.** `maxFee` / `allowlist` / `blocklist` rules under a namespace key (`eip155`) were documented to cover every chain of the family and were ignored for `eip155:1`. Rules are now looked up by namespace and by exact id, for the asked-for chain and the account's own: every matching fee cap is checked, a destination must be on every matching allowlist, any matching blocklist refuses. An account whose chain id stays unknown gets its namespace rules; an exact-id rule of its family refuses the write (`policy: 'chain'`), and rules of other families no longer refuse it.
  - **keyring: `removeSource` cannot lose a key.** It deleted the secret before saving the metadata, so a failed save left a source without its secret. The metadata now goes first, with the id in the new `KeyringState.pendingSecretDeletes`; the secret is deleted after, and a failed or interrupted delete is finished by `Keyring.load`. An id still pending cannot be adopted. `SecretStorage.delete` must be idempotent.
  - **keyring: parallel imports.** The duplicate check and the secret write ran outside the serialized state change, so two imports of one phrase at once could both land. They now run inside it; the second import fails with `duplicate`, and a secret written before a failed save is removed again.
- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: Seed bytes passed as a Node `Buffer` (or any view into a larger buffer) are now copied, not aliased. `Wallet`, `WalletManager` and `LocalSigner.fromSeed` took the copy with `.slice()`, which on a `Buffer` is a view sharing the caller's memory: zeroizing the input after construction changed every key derived later, and `dispose()` wiped the caller's bytes. New `copyBytes()` in core makes the independent copy; `sealBackup` copies byte secrets the same way and zeroizes its copy.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [a9a5e0a]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0
  - @anywalletkit/swap2-assets@0.1.5

## 0.3.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4

## 0.3.1

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.3.0

### Minor Changes

- 5cad90b: The allow/block lists check every destination a write goes to, read per chain shape (scan F16/F17). `WriteIntent` gains `destinations` (each EVM call's `to`; the NEAR `receiverId`, also of a base64 borsh transaction; the Tron recipient / contract / resource receiver decoded from `raw_data_hex` — never the optional JSON copy —, a Tron `contractAddress`; every TON message; the recipients and programs of decoded Solana instructions; approvals: the spender; revokes: the contracts called) and `destinationUnknown` (part of the write could not be read). Addresses are compared in one canonical form per chain, both sides: EVM lowercase, Tron 41-hex (base58 and hex entries match), TON raw `wc:hex` (friendly and raw forms match). An unknown destination is refused only when the chain has a blocklist and no `confirm` hook is set; otherwise `confirm` sees `destinationUnknown`. An allowlist needs every destination listed. `intent.to` is unchanged.
- 9b9492a: Revokes are `kind: 'revoke'` and are never stopped by the allowlist or the spender's blocklist entry: an `approve` / `signPermit` / EIP-2612 Permit of 0, raw revoke calldata (`approve(spender, 0)`, `approve(0x0, tokenId)`, `setApprovalForAll(…, false)`, Permit2 `lockdown`, or a batch of only these) and `revokeDelegation()`. Before, revoking a blocklisted drainer's allowance was refused, and with an allowlist only allowlisted spenders could be revoked. The blocklist still applies to the contract a revoke calls; the fee cap and `confirm` apply. `WriteIntent` gains `revokes`.
- 4b6d97f: No secret is an object property anywhere. `Wallet` no longer keeps the seed phrase string: it turns the phrase into the 64-byte seed in the constructor, hands each chain manager a copy, and `dispose()` zeroizes it and refuses later calls; `new Wallet(seedBytes)` and managers built from seed bytes are accepted (copied). `LocalSigner` keys and seeds and `WalletManager` seeds live in module WeakMaps, so `console.log`, `JSON.stringify`, `util.inspect` and crash reporters see only public fields; `LocalSigner.toJSON()` is the public view. Accounts get leaf signers (`LocalSigner.leafFromSeed`, `deriveLeaf`) that hold only their own key, never a copy of the master seed. Before: `JSON.stringify(account)` contained the private key and the master seed, and `console.log(wallet)` printed the phrase. The conformance chain suite now walks every property reachable from a manager and an account and fails if a key, the seed or the phrase is found. Manager constructors take `string | Uint8Array | Signer`.

### Patch Changes

- 5d7976e: Security audit 2026-10-13 fixes that had stayed on a side branch: Solana provider-tx guard refuses System Assign/Allocate, Token Batch and undecodable core instructions and checks ownership/authority in the post-state (F1, F2); tx-preview flags native value to unlabeled contracts and unverified token symbols (F5); approvals gets a strict `isRevokeCalldata` and a new `isRevokeTransaction` (F8); kit `applyPolicies` resolves or refuses an unknown EVM chain (F4); NEAR caps token storage deposits (F12); TON checks the jetton wallet's owner and master (F13); EVM signing detects the chain before the mismatch check and strips EIP-712 array types linearly (F16, F17); near-intents strips control characters from logs (F18).
- 2bf5ebc: Two backtracking regexes on dApp / provider input are gone:
  
  - **EIP-712 primary-type inference:** the field type is cut at the first `[`, linear and identical to wallet-evm's signer.
  - **base64 decoding of serialized Solana / NEAR transactions:** padding is stripped with a linear walk, and input above 8 MiB is not decoded.
  
  Measured on the old code: 24 s and 111 s for one hostile request, during which the wallet was frozen before any prompt.
- 6c43eaf: Policies classify a raw `sendTransaction`/`signTransaction` as a revoke only on `eip155` chains, and only for plain EVM calls.
  
  The fixed bypass: a Tron, NEAR or Solana write carrying EVM-looking `to`/`data` (a zero-amount approve) was treated as a harmless revoke. That skipped the allowlist, checked the blocklist only against the fake `to`, and told `confirm` it was a revoke, while the chain package signed the real `raw_data_hex` / `actions` / `instructions`.
- a978ccf: EIP-712 policies judge exactly what gets signed (scan F5/F13). The primary type is resolved as wallet-evm's signer resolves it — the explicit `primaryType`, else the unique type no other type references (new export `resolvePrimaryType`; ambiguous typed data throws, as the signer does) — instead of the first key of `types`, and when the caller omitted it the wrapped `signTypedData` forwards the same object with that `primaryType` made explicit (same EIP-712 hash). An EIP-2612 / DAI `Permit` is classified from fields declared in `types[primaryType]` only: a revoke needs a declared `value` (uint256) of 0 or a declared `allowed` (bool) of false, and undeclared message keys are ignored, so an unlimited permit can no longer pass as a revoke.
- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2

## 0.2.0

### Minor Changes

- 32ea93a: Policies guard every write surface of an account, not only `sendTransaction` / `transfer`: `signTransaction` (fee cap, lists, confirm — a module that signs and broadcasts on its own cannot skip them), `sign` (message signatures: confirm only), and the chain-specific `sendSerialized` / `signCompiled` / `signTransactionMessage` where an account has them. `WriteIntent.method` is the new `WriteMethod` union and carries `message`.
- 99555a7: Policies guard every signing surface, not a fixed list: `signTypedData`, `signPermit`, `approve`, Tron `signRaw`, NEAR `signNep413` / `signBuilt` join the known writes, and any account method named `sign*` / `send*` / `approve*` / `revoke*` / `transfer*` is guarded unless listed in `UNGUARDED_WRITES`. Approvals (`approve`, `signPermit`, EIP-2612 and Permit2 typed data) are checked against the spender — a blocklisted or non-allowlisted spender is refused — and `confirm` receives `kind: 'approval'` with `unlimited` and `deadline`. Other typed data is `kind: 'typedData'` (confirm only). `WriteIntent` gains `kind`; `isGuardedWrite` is exported.

### Patch Changes

- 0d5d074: `buildFeed` matches intent legs to chain rows through the chain alias table: an intent journaled under the catalog id (`bitcoin:mainnet`) now owns the row a source names by genesis hash (`bip122:…`), instead of leaving a bare "send" next to a pending intent; a row already on the page still inherits its intent.
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
  - @anywalletkit/core@0.2.0
  - @anywalletkit/swap2-assets@0.1.1

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
  - @anywalletkit/swap2-assets@0.1.0
