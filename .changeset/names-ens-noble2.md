---
"@anywalletkit/names-ens": patch
---

`@noble/hashes` 1.8 → 2.4 and `@scure/base` 1.2 → 2.4, the versions every other package uses, so an app no longer installs two copies of each. Bitcoin and Solana record decoding gives the same addresses (pinned by ENSIP-9, BIP-173 and BIP-350 vectors). No API change.
