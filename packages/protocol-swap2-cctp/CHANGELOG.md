# @anywalletkit/protocol-swap2-cctp

## 0.1.3

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [6b164bd]
- Updated dependencies [65c3bca]
  - @anywalletkit/protocol-swap2-core@0.3.1
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.1.2

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
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

## 0.1.1

### Patch Changes

- 966b3a3: `buildClaim` compares Circle's `expirationBlock` with the height the destination transmitter sees in `block.number`: on Arbitrum-stack chains that is the L1 height (the RPC block's `l1BlockNumber`), not the L2 height `eth_blockNumber` returns. A Base→Arbitrum transfer was held as "expired" (and re-attested on every poll) although it was claimable.
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

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
  - @anywalletkit/protocol-swap2-core@0.1.0
  - @anywalletkit/swap2-assets@0.1.0
