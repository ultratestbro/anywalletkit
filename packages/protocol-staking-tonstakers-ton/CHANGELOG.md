# @anywalletkit/protocol-staking-tonstakers-ton

## 0.2.7

### Patch Changes

- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.2.6

### Patch Changes

- Updated dependencies [8aa911d]
  - @anywalletkit/core@0.4.1

## 0.2.5

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- 8541692: Fixes from the 2026-10-25 audit: timeouts, failover and exact amounts.
  
  - **wallet-tron, wallet-near: timeouts.** Url providers had no timeout, so a node that never answered hung every call and failover never ran. Each request now times out after the new `timeoutMs` option (default 15 000; `AbortSignal.timeout`, or a timer on runtimes without it) and the next provider is tried.
  - **wallet-tron: broadcast outcome.** A broadcast without an answer is re-sent as the same signed bytes to the next provider, `DUP_TRANSACTION_ERROR` counts as accepted (it used to be reported as a failure, inviting a second transaction), and when no node answers the new `BroadcastUnknownError` (`maybeSent`, `hash` = txID) is thrown.
  - **wallet-near: broadcast outcome.** `send_tx` is never re-sent to another RPC; without a definitive answer (no response, a node timeout) it throws the new `BroadcastUnknownError` with the locally computed hash. Definitive refusals stay clean errors.
  - **wallet-tron: exact sun.** Balances went through `JSON.parse` and `Number()`, rounding above 2^53. Url providers now keep big integers exact; a custom transport that hands over an unsafe number is refused with a clear error, and a TRX transfer above 2^53 − 1 sun is refused before the node builds it.
  - **Lido, SSV, Tonstakers, Mellow:** their REST reads (APR, rewards, queue times, stats) time out after 15 s instead of hanging.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
  - @anywalletkit/core@0.4.0

## 0.2.4

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.2.3

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

## 0.2.2

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.2.1

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
