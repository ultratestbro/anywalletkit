---
"@anywalletkit/wallet-ton": patch
---

`describeTransaction` decodes TEP-62 NFT transfers (op `0x5fcc3d14`): new kind `nft-transfer` and an `nft` field on the message (`newOwner`, `responseDestination`, `forwardTonAmount`, forward payload), so a screen can name who receives the NFT instead of the NFT item address. New warnings: `nft-transfer` (names the new owner), `state-init` (the message deploys code and data) and `unknown-op` (a body op the wallet does not decode). New exports `NFT_TRANSFER_OP` and `TonNftDetails`; `DecodedBody` gains `{ type: 'nft-transfer' }`. Code that switches over `TonDescribedKind` or `TonWarningCode` should handle the new values; warnings stay informational and nothing new is refused.
