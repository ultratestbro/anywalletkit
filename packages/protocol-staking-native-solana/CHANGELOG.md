# @anywalletkit/protocol-staking-native-solana

## 0.1.1

### Patch Changes

- 3f10000: wallet-solana's signing guard reads the Stake program: it refuses a Stake `Authorize*` to another key, a `Withdraw` to anyone but the wallet, a `SetLockup*` with a foreign custodian or a lockup, and funding a stake account that the same transaction does not initialize (or split into) with the wallet as staker and withdrawer (`allowAuthorityChanges` overrides). It now signs taking back a pre-funded seed slot (`AllocateWithSeed` of a 200-byte Stake account the same transaction initializes for the wallet), so dust sent to every `stake:<i>` address no longer blocks native staking. `describeTransaction` names Stake instructions and what they set (`stake`, `withSeed` on program-call items); `decodeStakeInstruction` and `STAKE_PROGRAM_ADDRESS` are exported.
- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.1.0

### Minor Changes

- 24af20e: New module: native SOL staking through the Stake program, to the validators the app lists.
  
  - **Validators are the app's choice.** `validators` is required (vote accounts, optionally named), or `'any'` for wallets whose users pick from the whole cluster; there is no default. Before every delegation the validator is read live and refused when it is not listed, not found, delinquent, or above `maxCommission` (10 % by default). `listValidators()` / `getValidator()` return commission, activated stake, delinquency, latest vote credits, an APR estimate (validator inflation × supply ÷ staked SOL × (1 − commission)) and why a validator is not eligible; an `enrich` hook can add an explorer's APR, names or scores.
  - **Stake accounts at seed-derived addresses** (`create_with_seed(wallet, "stake:<i>", Stake)`): only the wallet signs, staker and withdrawer are always the wallet, and the position rebuilds from the address alone. `discover: true` also lists stake accounts other wallets created for the address (`getProgramAccounts` by staker and withdrawer).
  - **Statuses exactly as the program computes them**: activating / active / deactivating / inactive from the StakeHistory sysvar (the same integer warm-up / cool-down math the Core BPF stake program runs), with effective / activating / deactivating amounts, what can be withdrawn now, and the projected epoch and time it settles.
  - **Operations**: `stake` (create + initialize + delegate in one transaction, ≥ the minimum delegation, keeps `feeReserve` on the wallet), `requestWithdrawal` (deactivates whole accounts, splits a partial amount into a new account first; refuses parts below the minimum), `claimWithdrawals` (withdraws fully inactive accounts, up to 10 per transaction, by id or address), `delegate` (re-delegates an inactive account, or undoes a deactivation made this epoch), `merge`. Every write has a `quote*` twin that signs nothing.
  - **Reads**: `getStakeAccounts`, `getStakedBalance`, `getWithdrawalRequests`, `getApr`, `getRewards` (inflation rewards per epoch, in batches the RPC accepts), `getEpochInfo`, `getStakeParams`, `getMaxStakeable`.
  - **Only the wallet's own SOL**: an account `discover` finds where the wallet is only the stake authority is listed (`owned: false`, summed in `managedOnly`) but never unstaked, split, delegated or merged. Undoing an unstake re-checks the validator against the policy; an activating account moves only to a validator named in the call. Empty seed slots are used first; a slot someone pre-funded with dust can be taken over (Transfer + AllocateWithSeed) when the wallet allows it (`wallet-solana` refuses by default, and the module says why). A StakeHistory from an RPC node behind the current epoch is refused. Unstake plans try every account as the split source and keep the one with the fewest steps.
  - **Activity**: `describeActivity` labels stake / unstake / claim / delegate / merge transactions, with the validator's configured name; stake-pool transactions that touch the Stake program are left to their module.
  - Instructions are hand-encoded (no extra Solana SDK) and checked byte for byte against mainnet transactions; every write was simulated on mainnet through `wallet-solana` before release (`scripts/verify-live.mjs`). Runs under Hermes.
