# @anywalletkit/swap2-assets

## 0.1.5

### Patch Changes

- 07db4c1: Audit 2026-10-25, findings 16 and 17.
  
  - **Number() on bigints.** A real ESLint now runs on every package (`pnpm lint`, in CI): typescript-eslint's `no-floating-promises`, `await-thenable`, `no-misused-promises`, and a local `no-number-bigint` rule (`Number(x)` of a bigint is lossy above 2^53 and garbage on Hermes above 2^63). Its 92 findings are fixed: values that come from outside are range-checked as bigints before they become numbers (a typed-data or transaction `chainId`, token `decimals` in tx-preview, ABI string lengths, protobuf field numbers in Tron, an RPC nonce in extension-kit, the Permit2 lockdown count in kit's policies, Mellow's asset count); sort comparators compare bigints exactly; panic codes print the bigint; display values go through `bigintToNumber`. A `chainId` that is not a safe integer is now refused by wallet-evm before signing (`UnsafeTransactionError`), and `describeTransaction` reports it as a chain mismatch.
  - **engines.** Every package declares `"engines": { "node": ">=20" }`.
  - **Peers.** `expo-modules-core` in `backup-cloud` and `secure-storage-react-native` is `^58.0.0` (Expo SDK 58, the version the native modules are tested on) instead of `*`.
- a9a5e0a: package.json carried a second, empty `description` that overrode the real one, so npm showed the README badge line instead of the package description.

## 0.1.4

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).

## 0.1.3

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.

## 0.1.2

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.

## 0.1.1

### Patch Changes

- 7004ecf: New package: USDT0 — Tether's LayerZero OFT for USDT — as a swap2 provider. USDT / USDT0 between 13 EVM chains (Ethereum adapter, Arbitrum, OP, Polygon, HyperEVM, Ink, Berachain, Unichain, Sei, Plasma, Monad, MegaETH, X Layer) in one source transaction: `quoteOFT` + `quoteSend` on the OFT itself, `send` with the LayerZero fee as `msg.value` (declared as `nativeFee`), approval only for the Ethereum adapter, every deployment bound on-chain (`token()`, `approvalRequired()`, `peers`), preflight against the live fee, status from LayerZero Scan (DELIVERED carries the destination hash), and the `lzReceive` retry of a stored payload as the engine's claim. The asset catalog gains USDT0 on HyperEVM and Unichain.
- e0edbf6: Zcash is no longer hidden in the swap catalog (the wallet signs ZEC itself now). 1Click dry quotes from Zcash use a real t-address placeholder with an origin-chain refund, like every other source — the INTENTS-side refund special case is gone.

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).
