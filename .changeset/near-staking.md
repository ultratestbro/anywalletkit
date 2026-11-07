---
"@anywalletkit/protocol-staking-native-near": minor
"@anywalletkit/protocol-staking-liquid-near": minor
---

New modules: NEAR staking.

- `@anywalletkit/protocol-staking-native-near`: `deposit_and_stake` into the staking pools the app allows (factory pools with a known code hash, live fee and pause checks, current and next validator sets), unstake with the 4-epoch unbonding and an exact unlock epoch when the account's history is available, `withdraw_all` per pool. Quotes return the exact NEAR transactions so an external signer signs what was shown.
  - Exits (unstake, claim) need only the factory suffix and a known code hash, so a pool that was paused, raised its fee or left the set can always be left. An unstake next to an unlocked balance is sent as `[withdraw_all, unstake]` in one transaction; one next to a locked balance says it restarts the 4-epoch timer.
  - Every write takes `expected` (the confirmed transactions) and refuses with `quote-changed` when the fresh plan differs. Multi-pool claims use the account's `sendTransactions` hook (one approval) when it has one.
  - APR from `validator_reward_paid_prev_epoch` after the pool's fee (network average for pools new to the set, `treasury.near` excluded); the epoch clock is measured from the chain (~6.9 h). Share-rounding dust below 0.001 NEAR is not a withdrawal.
- `@anywalletkit/protocol-staking-liquid-near`: LiNEAR and Rhea rNEAR (the LiNEAR contract family), pinned by account id and code hash: stake, delayed unstake with the contract's unlock epoch, withdraw with a contract-liquidity check, APR from the price over time.
