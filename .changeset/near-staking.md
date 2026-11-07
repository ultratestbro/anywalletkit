---
"@anywalletkit/protocol-staking-native-near": minor
"@anywalletkit/protocol-staking-liquid-near": minor
---

New modules: NEAR staking.

- `@anywalletkit/protocol-staking-native-near`: `deposit_and_stake` into the staking pools the app allows (factory pools with a known code hash, live fee and pause checks, current and next validator sets), unstake with the 4-epoch unbonding and an exact unlock epoch when the account's history is available, `withdraw_all` per pool. Quotes return the exact NEAR transactions so an external signer signs what was shown.
- `@anywalletkit/protocol-staking-liquid-near`: LiNEAR and Rhea rNEAR (the LiNEAR contract family), pinned by account id and code hash: stake, delayed unstake with the contract's unlock epoch, withdraw with a contract-liquidity check, APR from the price over time.
