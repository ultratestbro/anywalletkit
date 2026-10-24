# @anywalletkit/history-evm

## 0.1.4

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2
  - @anywalletkit/swap2-assets@0.1.4

## 0.1.3

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1
  - @anywalletkit/swap2-assets@0.1.3

## 0.1.2

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2

## 0.1.1

### Patch Changes

- 82464d8: Alchemy limiter counts compute units (batches charged the sum of their calls), 10-call batches, rate-limit answers retried up to 3× with backoff; `alchemyComputeUnitsPerSecond` replaces `alchemyRateLimit`.
- b589402: Alchemy backend: transport failures (timeout / abort / DNS) on a JSON-RPC call are retried with the same backoff as rate limits, and when the per-page enrichment batch (`eth_getTransactionByHash` + receipt) still fails the page is served from the Transfers lists alone — bare rows without fee / status — instead of `HistoryUnavailableError`. Matters on chains where Alchemy is the only free backend (Base): one aborted call used to blank the whole chain's history.
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
