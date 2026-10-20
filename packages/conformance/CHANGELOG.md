# @forgewallet/conformance

## 0.2.0

### Minor Changes

- 386615c: `NameResolver` interface (`resolve(name, chain)`, forward-verified `reverse`, `avatar`, `supports`), `NameError` codes, `ResolvedName` with warnings, `nameResolvers([...])` to stack resolvers, `assertNameUnchanged` for the signing-time check, `isNameLike`. Conformance gains `namesSuite`.
- e0edbf6: `zcash` joins the keyring chains (`m/44'/133'/0'/0/i`, WIF or hex key import) and the conformance vectors (three seeds × five accounts, keys cross-checked with viem, address encoding with Blockchair).

### Patch Changes

- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @forgewallet/core@0.2.0

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`forgewallet` field in package.json, `manifest.json` next to the tarballs).

### Patch Changes

- Updated dependencies
  - @forgewallet/core@0.1.0
  - @forgewallet/tx-preview-evm@0.1.0
