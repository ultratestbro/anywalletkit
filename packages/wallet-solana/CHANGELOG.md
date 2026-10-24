# @anywalletkit/wallet-solana

## 0.1.1

### Patch Changes

- 82464d8: `WalletManager` keeps the 64-byte seed, never the mnemonic string: a phrase passed to a constructor is stretched there and dropped (strings cannot be zeroized, `Uint8Array`s can). Chain managers read it through `seedBytes()`; the base `dispose()` zeroizes it.
- 5993b62: A structured simulation error is named instead of crashing the error formatter. `@solana/kit` parses every JSON integer in an RPC response as a bigint, so `{InstructionError: [2n, {Custom: 6001n}]}` made the plain `JSON.stringify` throw "Do not know how to serialize a BigInt" — and that message replaced the real on-chain failure (Solana USDe → SOL via LI.FI in the Oct 16 funded run). Both `simulateWire` and the serialized-transaction check now format the error with a bigint-safe replacer (SDK-134).
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @anywalletkit/core@0.2.0

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @anywalletkit/core@0.1.0
