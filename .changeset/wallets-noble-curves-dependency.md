---
"@anywalletkit/wallet-solana": patch
"@anywalletkit/wallet-ton": patch
---

`@noble/curves` is a dependency. The read-only account imports `@noble/curves/ed25519.js` at runtime, but the package listed it only under `devDependencies`, so an app that did not install it itself (or get it hoisted from another package) failed with "Cannot find module '@noble/curves/ed25519.js'" on import. `pnpm pack:check` now refuses any package whose shipped JavaScript imports a package it does not declare as a dependency, peer or optional dependency.
