---
"@anywalletkit/wallet-zcash": patch
---

ZEC sends were refused after NU7 (bad-tx-consensus-branch-id-mismatch); NU6.2 / NU7 added to the upgrade table. NU7 activated at block 3 543 405 on 2026-11-06 with branch id 0x77190ad9, and transactions were still signed under NU6.3's 0x37a5165b. NU6.2 (block 3 364 600, 0x5437f330) only changes the id reported for historical heights. Both heights were read from the branch ids of mined transactions, and three mined NU7 transactions are now test fixtures. Blocks are 25 seconds since NU7, so the default `expiryDelta` is 120 blocks (~50 minutes, as 40 blocks were before). Nothing to change in apps.
