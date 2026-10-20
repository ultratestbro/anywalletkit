# @forgewallet/protocol-swap2-lifi

## 0.2.0

### Minor Changes

- 40df5d2: `chooseRoute` hook: a cross-chain quote first reads `/advanced/routes`, hands the single-transaction candidates to the app and restricts `/quote` to its choice (allowBridges / denyBridges / order). Any failure, or a chosen bridge that disappears before `/quote`, falls back to LI.FI's default pick.

### Patch Changes

- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [412164a]
- Updated dependencies [f427dec]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
- Updated dependencies [29af9d6]
  - @forgewallet/core@0.2.0
  - @forgewallet/protocol-swap2-core@0.2.0
  - @forgewallet/swap2-assets@0.1.1

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`forgewallet` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @forgewallet/core@0.1.0
  - @forgewallet/protocol-swap2-core@0.1.0
  - @forgewallet/swap2-assets@0.1.0
