# @anywalletkit/protocol-swap2-cctp

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
