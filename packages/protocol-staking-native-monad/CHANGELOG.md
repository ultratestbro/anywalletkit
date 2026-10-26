# @anywalletkit/protocol-staking-native-monad

## 0.1.1

### Patch Changes

- Updated dependencies [b08c01a]
- Updated dependencies [a354990]
  - @anywalletkit/core@0.5.0

## 0.1.0

### Minor Changes

- e009044: New module: native MON staking on Monad through the staking precompile (`0x…1000`), to the validators the app lists.
  
  - **Validators are the app's choice.** `validators` is required (ids, optionally named), or `'any'` for wallets whose users pick from the active set; there is no default list. Before every delegation and compound the validator is read live and refused when it is not listed, does not exist, is outside the consensus set or flagged (unless `allowInactive`), or charges more than `maxCommission` (10 % by default; both the current and the upcoming commission are checked). `listValidators()` / `getValidator()` return stake, commission, standing, an APR estimate (18 MON × blocks per year ÷ consensus stake × (1 − commission), block time measured on chain) and the reasons a validator is not eligible; an `enrich` hook can add an explorer's APR or names.
  - **Operations**: `stake` (`delegate` with the amount as value; active at n+1, or n+2 after the boundary block), `requestWithdrawal` (`undelegate` of active stake into the lowest free withdrawal slot), `claimWithdrawals` (one `withdraw` per ready request; ids pack `validatorId << 8 | withdrawId`), `compound`, `claimRewards`. Every write has a `quote*` twin, and every write is simulated with `eth_call` first, with the precompile's revert strings turned into plain words.
  - **Monad specifics handled**: the 10 MON reserve balance (a stake never leaves less, `getMaxStakeable()`), the 1 gwei minimum, epoch timing from `getEpoch()` (never block arithmetic), pagination that follows `nextValId` / `nextIndex` (pages are shorter than 100), withdrawals opening one epoch after the stake deactivates, the account and the read RPC both checked to be on Monad.
  - **Reads**: `listPositions` (active, activating, activating next, unclaimed rewards per validator), `getStakedBalance`, `getWithdrawalRequests({ validator?, validators? })`, `getEpoch`, `getNetworkStats`, `nextWithdrawId`. Withdrawal slots are read with a gap scan (until 32 empty slots past the last used one; `withdrawScan: 'full'` reads all 256). After a full exit the precompile drops the validator from `getDelegations`; the module still looks at listed validators, the ones it undelegated from, and those passed in `validators`, and `claimWithdrawals({ ids })` always works. Every write decision reads the validator fresh; display reads are cached a minute and never pull the ~200 network-stat reads into positions or writes.
  - **Activity**: `describeActivity` labels delegate / undelegate (with the amount) / withdraw / compound / claimRewards sent to the precompile, with the validator's configured name, and reads withdrawal and reward amounts from the receipt when the history source kept it.
  - Checked on Monad mainnet: selectors, struct layouts and revert strings against the live precompile, every write simulated as real delegators (`scripts/verify-live.mjs`). Runs under Hermes.
