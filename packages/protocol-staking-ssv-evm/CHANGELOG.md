# @forgewallet/protocol-staking-ssv-evm

## 0.3.0

### Minor Changes

- 6e61b1a: Ported from plain ESM on ethers v6 to TypeScript on viem, built with tsup (ESM + CJS + d.ts). Same exports, same calldata and typed data, same error messages; the `provider` option still takes an RPC url or an EIP-1193 object. Receipt waits now time out after 180 s (viem default) instead of waiting forever; the `./package` subpath export is gone (`./package.json` stays).

### Patch Changes

- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @forgewallet/core@0.2.0

## 0.2.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`forgewallet` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @forgewallet/core@0.1.0
