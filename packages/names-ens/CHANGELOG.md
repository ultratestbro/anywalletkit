# @anywalletkit/names-ens

## 0.2.3

### Patch Changes

- 2975c93: README: an npm badge and an Install section (npm / pnpm / yarn, the peers to add, a link to the package on npm and to the release workflow that publishes it with provenance).
- Updated dependencies [2975c93]
  - @anywalletkit/core@0.3.2

## 0.2.2

### Patch Changes

- 65c3bca: First release through npm trusted publishing: published from the release workflow over GitHub OIDC, with no npm token anywhere. No code change in this package beyond what its other changesets list.
- Updated dependencies [65c3bca]
  - @anywalletkit/core@0.3.1

## 0.2.1

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
  - @anywalletkit/core@0.3.0

## 0.2.0

### Minor Changes

- 386615c: New package: ENS on the core `NameResolver` — ENSIP-15 normalization, Universal Resolver forward resolution with wildcard + CCIP-Read, one chain per call via ENSIP-9/11 coin types (EVM L2s, Bitcoin script records, Solana keys) with no fallback to the mainnet address, forward-verified primary names incl. ENSIP-19 L2 names, avatars as URLs, confusable / mixed-script / punycode warnings, TTL cache.

### Patch Changes

- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
  - @anywalletkit/core@0.2.0
