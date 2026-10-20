# @forgewallet/history-evm

## 0.1.1

### Patch Changes

- 82464d8: Alchemy limiter counts compute units (batches charged the sum of their calls), 10-call batches, rate-limit answers retried up to 3× with backoff; `alchemyComputeUnitsPerSecond` replaces `alchemyRateLimit`.
- b589402: Alchemy backend: transport failures (timeout / abort / DNS) on a JSON-RPC call are retried with the same backoff as rate limits, and when the per-page enrichment batch (`eth_getTransactionByHash` + receipt) still fails the page is served from the Transfers lists alone — bare rows without fee / status — instead of `HistoryUnavailableError`. Matters on chains where Alchemy is the only free backend (Base): one aborted call used to blank the whole chain's history.
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
  - @forgewallet/core@0.2.0
  - @forgewallet/swap2-assets@0.1.1

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`forgewallet` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @forgewallet/core@0.1.0
  - @forgewallet/swap2-assets@0.1.0
