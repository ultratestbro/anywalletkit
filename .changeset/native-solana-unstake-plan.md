---
"@anywalletkit/protocol-staking-native-solana": patch
---

`unstake` finds a plan whenever one exists. `planUnstakeSteps` picked whole accounts greedily and refused amounts with a valid plan (accounts 1.1 / 1.8 / 2.1 / 2.3 SOL, minimum 1, unstake 4: 1.1 + 1.8 whole and 1.1 split off 2.1). Pools of up to 16 accounts are now searched exhaustively for the plan with the fewest steps; larger ones keep the greedy search.
