# @anywalletkit/protocol-swap2-router

## 0.2.0

### Minor Changes

- 7f5d0fe: Value information on quotes (owner decision 2026-10-16: inform, never block). `quoteValues(prices, params, quotes)` in swap2-router gives every quote its USD in / out, loss %, the venue's price impact and the better alternative inside the set; the Uniswap provider measures its pool's price impact with a 1/1000 probe on the chosen route and reports it as `providerData.priceImpactBps`. The Oct 16 funded run lost ~$33 on two Uniswap legs that nothing compared against the other venues.

### Patch Changes

- bd4ea91: `bigintToNumber` / `bigintToUnits` in core: BigInt → Number that stays correct on engines whose multi-limb conversion is broken (Hermes on Linux x64 returns 3·2^64 for `Number(2n ** 64n)`). Aave rates and health factors, Morpho utilization / health / LTV / fees and the router's quote USD values now convert through it.
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
