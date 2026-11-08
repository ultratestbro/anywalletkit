# @anywalletkit/protocol-staking-liquid-near

## 0.1.0

### Minor Changes

- 73d83a0: New modules: NEAR staking.
  
  - `@anywalletkit/protocol-staking-native-near`: `deposit_and_stake` into the staking pools the app allows (factory pools with a known code hash, live fee and pause checks, current and next validator sets), unstake with the 4-epoch unbonding and an exact unlock epoch when the account's history is available, `withdraw_all` per pool. Quotes return the exact NEAR transactions so an external signer signs what was shown.
    - Exits (unstake, claim) need only the factory suffix and a known code hash, so a pool that was paused, raised its fee or left the set can always be left. An unstake next to an unlocked balance is sent as `[withdraw_all, unstake]` in one transaction; one next to a locked balance is refused (`timer-reset-refused`) unless `allowTimerReset`, and the quote then warns that it restarts the 4-epoch timer.
    - Every write takes `expected` (the confirmed transactions) and refuses with `quote-changed` when the fresh plan differs. Multi-pool claims use the account's `sendTransactions` hook (one approval) when it has one.
    - APR from `validator_reward_paid_prev_epoch` after the pool's fee (network average for pools new to the set, `treasury.near` excluded); the epoch clock is measured from the chain (~6.9 h). Share-rounding dust below 0.001 NEAR is not a withdrawal.
  - `@anywalletkit/protocol-staking-liquid-near`: LiNEAR and Rhea rNEAR (the LiNEAR contract family), pinned by account id and code hash: stake, delayed unstake with the contract's unlock epoch, withdraw with a contract-liquidity check, APR from the price over time.
    - Writes refuse a contract whose live code hash is not pinned or that is paused (a missing or failing `is_paused` counts as paused), exits included. Only `deposit_and_stake`, `unstake`, `unstake_all` and `withdraw_all` are ever built: never `ft_transfer_call` into the contract (it has no `ft_on_transfer`).
    - `deposit_and_stake` registers the account itself, so a stake is one action with no `storage_deposit`. `requestWithdrawal` takes token units and sends their NEAR value (`unstake_all` for the whole balance); an unlocked balance is withdrawn first in the same transaction, or the unstake is refused (`relock-refused`, unless `allowRelock`) when the contract cannot pay it yet.
    - Claims check the contract's liquid balance (minus what it keeps: 1 NEAR or its storage cost, whichever is more) and refuse with `awaiting-liquidity` until its payout arrives; requests carry the exact unlock epoch and its date. Every write takes `expected` and refuses with `quote-changed` when the fresh plan differs.
  - Both modules count the prepaid gas NEAR buys upfront at `min_gas_purchase_price` (10^9 on mainnet, ten times the gas price): quotes carry `upfront` and every balance check uses it, `stake` leaves at least one unstake's upfront gas (`quote.reserve`), `fee` uses wallet-near's +10 % margin so it passes as `maxFee`, and the module checks `maxFee` itself. Prepaid gas: 50 Tgas per call (native), 30 Tgas (liquid).
  - An unstake that would restart the wait of a balance still unbonding is refused (`timer-reset-refused`) unless `allowTimerReset`; never below 0.001 NEAR.
  - Native: staking-farm pools are checked against the fee already scheduled for the next epoch (`nextFee`); a pool.near pool upgraded to factory-allowed code can still be left; a pool-discovery outage leaves balances, requests and claims working on the known pools (`partial`); an unstake in an epoch's last heights is dated as a two-epoch range.
  - Liquid: what the contract cannot pay out is max(1 NEAR, its storage cost) (`LiquidPoolInfo.kept`).
