# @anywalletkit/runtime-hermes

## 0.2.0

### Minor Changes

- 294319e: `@anywalletkit/runtime-hermes/fast-pbkdf2`: a pure-JS drop-in for the native `react-native-fast-pbkdf2` module that `@ton/crypto-primitives` (under `wallet-ton`) requires on Metro. Resolve the module to it in `metro.config.js` and the bundle builds without a native dependency, and TON 24-word mnemonic imports work on the device instead of failing on a throwing stub.

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.

## 0.1.1

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.

## 0.1.0

### Minor Changes

- First versioned release of the SDK: every package leaves 0.0.1 / the ported 0.1.x. From here on versions move only through changesets, and every vendored build carries the commit it was built from (`anywalletkit` field in package.json, `manifest.json` next to the tarballs).
