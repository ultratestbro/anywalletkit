---
"@anywalletkit/protocol-staking-ssv-evm": patch
---

`stake` checks the SSV balance before approving. With too little SSV the approval was sent (gas paid, an allowance left behind) and only then the stake proof failed. `stake` and `quoteStake` now refuse first: "The account holds X SSV base units, Y needed to stake."
