# @anywalletkit/kit

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
