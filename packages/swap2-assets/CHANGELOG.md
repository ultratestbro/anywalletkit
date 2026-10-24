# @anywalletkit/swap2-assets

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
