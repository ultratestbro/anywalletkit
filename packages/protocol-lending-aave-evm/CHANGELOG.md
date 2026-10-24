# @anywalletkit/protocol-lending-aave-evm

## 0.2.1

### Patch Changes

- d469a3c: `rayToApyPct` compounds through `expm1(n·log1p(x))` instead of `pow(1 + x, n)`: with per-second compounding (n = 31 536 000) the pow form depends on the engine's libm and drifted on Hermes/Linux.
- bd4ea91: `bigintToNumber` / `bigintToUnits` in core: BigInt → Number that stays correct on engines whose multi-limb conversion is broken (Hermes on Linux x64 returns 3·2^64 for `Number(2n ** 64n)`). Aave rates and health factors, Morpho utilization / health / LTV / fees and the router's quote USD values now convert through it.
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
