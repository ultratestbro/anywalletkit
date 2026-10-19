---
"@forgewallet/protocol-swap2-core": patch
---

Swap2 status ids are minted as `awk1.<provider>.<intent>[.<sourceTxHash>]`; ids minted under the old `awk1.` prefix still decode (`SWAP2_ID_PREFIX` exported).
