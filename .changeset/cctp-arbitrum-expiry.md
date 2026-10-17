---
"@forgewallet/protocol-swap2-cctp": patch
---

`buildClaim` compares Circle's `expirationBlock` with the height the destination transmitter sees in `block.number`: on Arbitrum-stack chains that is the L1 height (the RPC block's `l1BlockNumber`), not the L2 height `eth_blockNumber` returns. A Base→Arbitrum transfer was held as "expired" (and re-attested on every poll) although it was claimable.
