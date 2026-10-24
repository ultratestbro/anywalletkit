# @anywalletkit/protocol-swap2-near-intents

## 0.1.1

### Patch Changes

- e97a936: Corridors the app pauses go in through config (`suspendedChains: {caip2: reason}`) and are refused up front by name ("1Click corridor paused by the app: …") — the SDK itself pauses nothing: a venue-side degradation (1Click's HOT omni-bridge assets answering "not available" since 2026-10-16) is the wallet's operational switch, lifted the same way when the venue recovers. Chains the catalog carries no 1Click id for are still not declared.
- e0edbf6: Zcash is no longer hidden in the swap catalog (the wallet signs ZEC itself now). 1Click dry quotes from Zcash use a real t-address placeholder with an origin-chain refund, like every other source — the INTENTS-side refund special case is gone.
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
