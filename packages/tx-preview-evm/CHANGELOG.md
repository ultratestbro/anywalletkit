# @anywalletkit/tx-preview-evm

## 0.4.0

### Minor Changes

- eb628a8: Permit-style approvals are decoded. An EIP-2612 `permit()` call (`0xd505accf`), Permit2 `permit()` single (`0x2b67b570`) and batch (`0x2a2d80d1`) and `increaseApproval` (`0xd73dd623`) came back with no `approval` and no unlimited or spender warnings. Now they carry `approval`: for an EIP-2612 permit the token is the call's target, for Permit2 it is read from the struct, and `approval-unlimited` / `approval-unknown-spender` apply as for `approve`. A Permit2 batch lists every allowance in the new `DecodedCall.approvals` (the first is also `approval`), and each one gets its own checks. The permits are read strictly, as their contracts read them: a body too short for the ABI head, or with an offset or length out of range, is flagged `unparsedApproval` and gives the new `approval-unparsed` warning instead of passing as a plain contract call.
  
  **Breaking:** `CheckCode` gains `"approval-unparsed"`; a `switch` over check codes that must be exhaustive needs a case for it.

## 0.3.0

### Minor Changes

- c59c8cc: `decodeCall` reads the approval and transfer calls the way the EVM executes them, not with a strict ABI decoder: selectors in any letter case, calldata that is too short zero-padded, address words by their low 20 bytes, any non-zero bool word as `true`. Before, `0x095EA7B3…` approves, a WETH9 approve one byte short and `setApprovalForAll(operator, 2)` threw in the decoder and showed as plain calls while the token contract executed them. Every Permit2 `approve(token, spender, uint160, uint48)` is an approval at any address (zkSync Era's Permit2 is not the CREATE2 one). Calldata that is not hex bytes is `undecodable: true` on the `DecodedCall` and a new `calldata-undecodable` warning in `checksFor`. swap2's quote and claim calldata gates refuse undecodable calldata.
  
  **Breaking:** swap calldata that is not hex bytes is refused (it used to pass as a plain call). Approve and transfer calldata a strict ABI decoder rejected (an upper-case selector, a short last word, a non-canonical bool) is now read as the approval or transfer the token executes, and checked like one. A review can show the new warning code `calldata-undecodable`. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.

## 0.2.0

### Minor Changes

- eec3745: `checksFor` reviews every call, not only the last. Each call's target gets `contract-known` / `contract-unknown` (transfer-shaped calls included — a contract can wear the selector; approvals excepted, their spender and amount have their own checks); native value is rated per call (`native-value` warns with the address when the receiving contract is not in `known`). An approval of 2^128 − 1 or more is unlimited (the SDK-wide threshold; 2^255 − 1 used to pass as "exact"), and a bounded approval with no `expectedApproval` is the new `approval-unchecked` (status `unknown`) instead of `approval-exact: ok`.

### Patch Changes

- 398129f: Node 20 is no longer supported: `engines.node` is now `>=22`. Node 20 reached end of life in April 2026 and gets no security fixes, including the October 2026 release (Brotli decoder, `dns.resolve`, TLS hostname checks; fixed in 22.23.4, 24.22.1 and 26.12.1). CI tests on Node 22 and 24 and refuses to run on an unpatched Node.

## 0.1.4

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.

## 0.1.3

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).

## 0.1.2

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.

## 0.1.1

### Patch Changes

- 5d7976e: Security audit 2026-10-13 fixes that had stayed on a side branch: Solana provider-tx guard refuses System Assign/Allocate, Token Batch and undecodable core instructions and checks ownership/authority in the post-state (F1, F2); tx-preview flags native value to unlabeled contracts and unverified token symbols (F5); approvals gets a strict `isRevokeCalldata` and a new `isRevokeTransaction` (F8); kit `applyPolicies` resolves or refuses an unknown EVM chain (F4); NEAR caps token storage deposits (F12); TON checks the jetton wallet's owner and master (F13); EVM signing detects the chain before the mismatch check and strips EIP-712 array types linearly (F16, F17); near-intents strips control characters from logs (F18).
- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- 87f9823: "eth_simulateV1 is unsupported" (→ the `eth_call` fallback) is decided from the structured error first — JSON-RPC code -32601 / -32004 or viem's `MethodNotFoundRpcError` / `MethodNotSupportedRpcError` anywhere on the cause chain, then a -32601/-32004 code in an HTTP error's JSON body — and only then by a bounded, linear text match on the first 300 characters of `details` / `shortMessage` / `message` (Monad's -32000 "`validation: false` is not supported yet" still falls back). The old `method.*not` regex ran over the whole node-supplied message and backtracked quadratically on a crafted megabyte (scan F23). New export `simulateUnsupported`.

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).
