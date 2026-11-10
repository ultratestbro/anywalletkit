# @anywalletkit/protocol-staking-native-near

## 0.2.1

### Patch Changes

- Updated dependencies [9677422]
- Updated dependencies [5c928b2]
  - @anywalletkit/wallet-near@0.4.2

## 0.2.0

### Minor Changes

- dd93115: Native NEAR staking review fixes.
  
  This is a minor release because three things change for apps: `NearUnstakeQuote.unlock` can be `null`, there is a new error code `claim-first` and a new warning code `leaves-dust`, and `stake` leaves a bigger reserve (about 0.11 NEAR instead of 0.055 NEAR), so `getMaxStakeable()` is lower and a very small account may no longer be able to stake.
  
  - `@anywalletkit/protocol-staking-native-near`: a partial unstake that would leave less than 0.001 NEAR unstaked in the pool is refused with `below-minimum`. Such a balance was sent, then never shown as a request and never claimable through the module.
  - A partial unstake that would leave less than 0.001 NEAR staked is refused with `below-minimum` too, and the message says to unstake `'all'`. Such a remainder could not be taken out by any later partial unstake.
  - The whole of a stake below 0.001 NEAR (made outside the module) can still be unstaked, with `'all'` or its exact amount, even in a paused pool. The quote carries the warning `leaves-dust`: the balance it leaves unstaked is below the claim minimum.
  - Unstake and claim no longer depend on the validator set or the epoch, which only decorate them. When those reads fail, the unstake still goes out with `unlock: null` (the quote's `unlock` type is now `UnlockEstimate | null`). Requests, balances and claims still work too: positions then carry `poolInfo: null` and no unlock estimate. Exits are always possible from a known pool, as the README says.
  - The reserve a stake leaves now covers the largest exit: an unstake that withdraws an unlocked balance first (`[withdraw_all, unstake]` in one transaction, about 0.11 NEAR of upfront gas today, up from one unstake's 0.055). Before, a user who staked the most allowed and later unstaked the rest next to an unlocked balance got `InsufficientFundsError`, with nothing saying how to get out. If the balance still cannot pay both calls (it was spent, or gas got dearer) but can pay the `withdraw_all` alone, the unstake is refused with the new code `claim-first`. Its `details.id` names the request to claim. After that claim, the unstake needs the gas of one call only. We chose a bigger reserve plus a clear refusal over quietly sending something else. Sending `withdraw_all` alone would not be the unstake the user asked for. Sending the unstake alone would lock the unlocked NEAR for 4 more epochs. The extra reserve stays on the user's own account as spendable NEAR.
  - Every `*.pool.near` pool now gets the scheduled-fee check (`get_pool_summary`, the higher of the current and the next fee), including a staking-farm build the app accepted through `codeHashes`. Before, such a build skipped the check, so a pool with a 100 % fee already scheduled read as eligible.
  - The spendable balance no longer subtracts `locked` from a `view_account.amount` that never included it. It is now `amount − max(0, storage − locked)`, because the locked balance pays for storage first. Accounts with a direct stake were capped too low, or refused everything when `locked ≥ amount`.
  - `@anywalletkit/wallet-near`: `getAccountView().available`, `getAvailableBalance()` and the transaction preflight use the same corrected rule, `amount − max(0, storage − locked)`. An account holding a locked balance is no longer told it can spend less than it can.

### Patch Changes

- Updated dependencies [dd93115]
  - @anywalletkit/wallet-near@0.4.1

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
