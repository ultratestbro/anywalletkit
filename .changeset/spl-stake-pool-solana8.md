---
"@anywalletkit/protocol-staking-spl-stake-pool-solana": patch
---

`@solana/addresses` and `@solana/instructions` 3.0 → 8.6, the versions `@solana/kit` 8.6 (and so `@anywalletkit/wallet-solana`) depends on, so an app no longer installs the 3.x Solana packages next to kit. The instructions, derived addresses and compiled messages this module builds are byte-for-byte the same (pinned by fixtures captured before the move). No API change.
