# @anywalletkit/core

## 0.2.0

### Minor Changes

- bd4ea91: `bigintToNumber` / `bigintToUnits` in core: BigInt → Number that stays correct on engines whose multi-limb conversion is broken (Hermes on Linux x64 returns 3·2^64 for `Number(2n ** 64n)`). Aave rates and health factors, Morpho utilization / health / LTV / fees and the router's quote USD values now convert through it.
- 386615c: `NameResolver` interface (`resolve(name, chain)`, forward-verified `reverse`, `avatar`, `supports`), `NameError` codes, `ResolvedName` with warnings, `nameResolvers([...])` to stack resolvers, `assertNameUnchanged` for the signing-time check, `isNameLike`. Conformance gains `namesSuite`.

### Patch Changes

- 82464d8: `WalletManager` keeps the 64-byte seed, never the mnemonic string: a phrase passed to a constructor is stretched there and dropped (strings cannot be zeroized, `Uint8Array`s can). Chain managers read it through `seedBytes()`; the base `dispose()` zeroizes it.

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).
