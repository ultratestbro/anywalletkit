# @anywalletkit/protocol-swap2-usdt0

## 0.1.4

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- Updated dependencies [07db4c1]
- Updated dependencies [80d6451]
- Updated dependencies [a9a5e0a]
- Updated dependencies [80d6451]
- Updated dependencies [80d6451]
- Updated dependencies [c4dc4d6]
- Updated dependencies [ed99146]
  - @anywalletkit/core@0.4.0
  - @anywalletkit/protocol-swap2-core@0.4.0
  - @anywalletkit/swap2-assets@0.1.5

## 0.1.3

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/protocol-swap2-core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4

## 0.1.2

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.1.1

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- d08e37e: USDT0 no longer puts raw viem transport errors into refusal reasons or preflight errors. Those errors carry `URL: …`, which includes the key of a keyed RPC.
  
  - **USDT0:** an RPC failure becomes `usdt0: RPC for <chain> unavailable — try again`, and any other text loses its URLs.
  - **swap2-core:** new `redactUrls()`. Servers that forward refusal text to clients should pass it through this.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
- Updated dependencies [0d68fda]
- Updated dependencies [6568e08]
- Updated dependencies [06cecff]
- Updated dependencies [24b888a]
- Updated dependencies [bdc77c2]
- Updated dependencies [4fcb9b6]
- Updated dependencies [d08e37e]
  - @anywalletkit/core@0.3.0
  - @anywalletkit/protocol-swap2-core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2

## 0.1.0

### Minor Changes

- 7004ecf: New package: USDT0 — Tether's LayerZero OFT for USDT — as a swap2 provider. USDT / USDT0 between 13 EVM chains (Ethereum adapter, Arbitrum, OP, Polygon, HyperEVM, Ink, Berachain, Unichain, Sei, Plasma, Monad, MegaETH, X Layer) in one source transaction: `quoteOFT` + `quoteSend` on the OFT itself, `send` with the LayerZero fee as `msg.value` (declared as `nativeFee`), approval only for the Ethereum adapter, every deployment bound on-chain (`token()`, `approvalRequired()`, `peers`), preflight against the live fee, status from LayerZero Scan (DELIVERED carries the destination hash), and the `lzReceive` retry of a stored payload as the engine's claim. The asset catalog gains USDT0 on HyperEVM and Unichain.
- 2d6c0f1: USDT0 on Mantle (eid 30181), Morph (30322) and Flare (30295) — 16 deployments, every one re-read on-chain (token, approvalRequired, sharedDecimals, endpoint, Arbitrum peer).

### Patch Changes

- 3ea8e2d: Activity: an OFT `send` folds the LayerZero messaging fee (the native value) into `fee` instead of listing it as an asset the owner swapped away, and names both ends when the calldata carries the destination ("Bridged USDT → USDT0", subtitle "USDT0 · Ethereum → HyperEVM").
- 5c02895: The sealed LayerZero fee carries 25 % headroom over the quote: the fee is paid at send time and moves with gas, so a quote a minute old failed preflight ("fee rose … re-quote"); the endpoint refunds the unused part to the trader in the same transaction. Preflight refuses only a fee past the headroom.
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [412164a]
- Updated dependencies [f427dec]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
- Updated dependencies [29af9d6]
  - @anywalletkit/core@0.2.0
  - @anywalletkit/protocol-swap2-core@0.2.0
  - @anywalletkit/swap2-assets@0.1.1
