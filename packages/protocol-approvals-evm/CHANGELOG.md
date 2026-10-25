# @anywalletkit/protocol-approvals-evm

## 0.4.3

### Patch Changes

- 80d6451: Lido, SSV, Mellow and Approvals read over a list of RPCs. They take the account's RPC from wallet-evm's config, where `provider` may be a list (the documented failover form); they handed that list to viem's `custom()`, which needs one EIP-1193 provider, so every read failed with `Cannot read properties of undefined (reading 'bind')`. A list now becomes a `fallback` transport, as in wallet-evm, Aave and Morpho, and each module's own `provider` option accepts a list too. Audit 2026-10-25, #1.4.
- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 80d6451: Raw `approve(spender, 0)` calldata is no longer a revoke to the policy engine. On an ERC-20 it zeroes an allowance, on an ERC-721 it approves `spender` for token #0, and the calldata cannot tell them apart: read as a revoke, it skipped the spender's blocklist entry and the allowlist, so a blocklisted drainer could be granted an NFT through `sendTransaction`. It is now `kind: 'approval'` with the spender as a destination. Any single raw `approve` / `setApprovalForAll(…, true)` call is an approval (amount and `unlimited` read off the calldata; the contract called is checked too), and in a batch their spenders join the destinations. If you use an allowlist, it must now also hold the spenders of raw approve calldata (e.g. Permit2 or a router's approval address), and a swap engine's `approve(spender, 0)` cleanup reaches `confirm` as `kind: 'approval'` with amount 0. Unambiguous revokes are unchanged: `approve({amount: 0})`, `approve(0x0, tokenId)`, `setApprovalForAll(operator, false)`, Permit2 `lockdown`, `revokeDelegation()`. `ApprovalsProtocolEvm.revokeAll` with `batch: true` now revokes ERC-20 through the account's `approve` when it has one, so a blocklisted spender can still be revoked. Audit 2026-10-25, #5.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0

## 0.4.2

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.4.1

### Patch Changes

- 6c4f606: The account types these modules take no longer declare a public `_config`. A `wallet-evm` account keeps its RPC in a protected `_config`, so `new LidoProtocolEvm(account)` (and SSV, Mellow, Approvals) with a real `WalletAccountEvm` or `WalletAccountReadOnlyEvm` failed to type-check — only the loosely typed `wallet.registerProtocol` path compiled. The modules still pick up the account's RPC when `config.provider` is absent.
- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

## 0.4.0

### Minor Changes

- 5d7976e: Security audit 2026-10-13 fixes that had stayed on a side branch: Solana provider-tx guard refuses System Assign/Allocate, Token Batch and undecodable core instructions and checks ownership/authority in the post-state (F1, F2); tx-preview flags native value to unlabeled contracts and unverified token symbols (F5); approvals gets a strict `isRevokeCalldata` and a new `isRevokeTransaction` (F8); kit `applyPolicies` resolves or refuses an unknown EVM chain (F4); NEAR caps token storage deposits (F12); TON checks the jetton wallet's owner and master (F13); EVM signing detects the chain before the mismatch check and strips EIP-712 array types linearly (F16, F17); near-intents strips control characters from logs (F18).
- 6568e08: Renames: the base of every swap2 error is now `Swap2Error`; the pinned derivation vectors are exported as `derivationVectors` and shipped as `vectors/derivation.json` (values unchanged). The approvals module drops its policy-engine rule set and its `Policy` / `PolicyRule` / `PolicyContext` types — the kit's policies treat revokes as `kind: 'revoke'` on their own; `isRevokeCalldata` and `isUnlimitedAmount` stay. THORChain's default `clientId` is `anywalletkit`.

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.3.0

### Minor Changes

- 6e61b1a: Ported from plain ESM on ethers v6 to TypeScript on viem, built with tsup (ESM + CJS + d.ts). Same exports, same calldata and typed data, same error messages; the `provider` option still takes an RPC url or an EIP-1193 object. Receipt waits now time out after 180 s (viem default) instead of waiting forever; the `./package` subpath export is gone (`./package.json` stays).

### Patch Changes

- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @anywalletkit/core@0.2.0

## 0.2.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
