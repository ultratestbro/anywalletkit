# @anywalletkit/protocol-staking-native-near

Native NEAR staking for any NEAR account: `deposit_and_stake` into the staking pools **your app
allows**, unstake with the 4-epoch unbonding (about 21–28 h at ~6.9 h per epoch), `withdraw_all`
once unlocked. No extra contract, no token: the position is the account's balance in each pool.

```sh
npm install @anywalletkit/protocol-staking-native-near @anywalletkit/wallet-near @anywalletkit/kit
```

## Usage

```ts
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerNear } from '@anywalletkit/wallet-near'
import { NativeStakingProtocolNear } from '@anywalletkit/protocol-staking-native-near'

const wallet = new Wallet(seedPhrase)
wallet.registerWallet('near', WalletManagerNear, { provider: 'https://free.rpc.fastnear.com' })
const account = await wallet.getAccount('near')

const staking = new NativeStakingProtocolNear(account, { pools: ['astro-stakers.poolv1.near'] }) // or 'any'

const quote = await staking.quoteStake({ amount: 10n ** 24n })            // 1 NEAR
// quote.transactions is exactly what stake() sends; quote.pool carries the live checks, quote.apr the APR
await staking.stake({ amount: 10n ** 24n, expected: quote.transactions })  // re-checks, refuses if the plan changed

const unstake = await staking.quoteRequestWithdrawal({ amount: 'all' })     // unstake_all ([withdraw_all, unstake_all] if unlocked NEAR waits)
await staking.requestWithdrawal({ amount: 'all', expected: unstake.transactions })
// … 4 epochs later (unstake.unlock.earliestAt … latestAt) …
await staking.claimWithdrawals()                                            // withdraw_all per pool
```

Amounts are yoctoNEAR (bigint). Reads use `provider`, else the wallet-near account's own RPC.

### External signers (wallet-selector and the like)

The module touches only `account.chain`, `account.getAddress()` and, for writes,
`account.sendTransaction(tx)` with a `NearTransaction` of function-call actions (`{ receiverId,
actions }`, no signer, nonce or block hash). Balances, fees and contract state come from the module's
own RPC, so an adapter over a browser wallet is small: map each `functionCall` to the wallet's action
type, sign and send, and return `{ hash, fee }`. An account that also has
`sendTransactions(txs)` (one approval for several transactions) gets multi-pool claims in one prompt.
Pass `provider`: such accounts have no RPC of their own.

A watch-only object with `chain` and `getAddress()` is enough for every read (positions, requests,
APR). Writes on it throw `ReadOnlyAccountError`.

## Config

| Option | Default | |
|---|---|---|
| `pools` | — (required) | Pool ids (`'x.poolv1.near'` or `{ id, name }`), or `'any'` to let users pick from the validator set. |
| `defaultPool` | the only listed pool | Used when a call names no pool. |
| `maxFee` | `10` | Percent. Pools above it are refused for new stake. Read fresh at every stake; compared in integers. |
| `allowInactive` | `false` | Stake into pools outside the current or next validator set (that stake earns nothing). |
| `minUptime` | `0` (off) | Refuse pools whose production this epoch is below it, percent. |
| `codeHashes` | — | Extra staking-pool code hashes to accept on top of the pinned builds. |
| `provider` / `timeoutMs` | the account's RPC / 15 s | URL, transport, or a failover list. |
| `network` | the account's | `'mainnet'` / `'testnet'`. The account must be on `near:<network>`. |
| `reserve` | 0.02 NEAR | Left on the account by `stake`; never less than one unstake's upfront gas (~0.055 NEAR today, see Fees). |
| `gas` | 50 Tgas per call | Prepaid gas. It is all bought upfront at `min_gas_purchase_price`; the unburnt part is refunded. |
| `discover` | `'fastnear'` | How positions outside `pools` are found: fastnear's indexer (`/v1/account/{id}/staking`), your own `(accountId) => poolIds`, or `false`. A failed lookup makes `listPositions` throw (never "no stake"); balances, requests and claims go on with the listed, passed and touched pools and say `partial: true`. |
| `history` | — | A `HistorySource` (e.g. wallet-near's `createNearHistory`): dates the last unstake for an exact unlock epoch. |
| `enrich` | — | `(ids) => ({ [id]: { apr, name, logo, … } })`. Decoration only; a failing enricher is ignored. |
| `concurrency` | `4` | Reads in flight. |

## Methods

| Shared `StakingProtocol` | On NEAR |
|---|---|
| `stake({ amount, pool?, expected? })` | `deposit_and_stake()` with exactly `amount` attached. There is no "stake everything". |
| `requestWithdrawal({ amount \| 'all', pool?, allowTimerReset?, expected? })` | `unstake({ amount })` / `unstake_all()`; `[withdraw_all, unstake…]` in one transaction when an unlocked balance waits |
| `getWithdrawalRequests({ pools? })` | one request per pool holding an unstaked balance; `id = poolRequestId(pool)` |
| `claimWithdrawals({ ids?, pools?, expected? })` | `withdraw_all()` per pool, one approval with `sendTransactions` |
| `getStakedBalance()` | `balance` = staked, `total` = staked + unstaked, plus `unstaked`, `withdrawable`, `positions` |
| `getApr({ pool? })` | the pool's (else the default pool's) delegator APR; without a pool, the network average after a 10 % fee |

NEAR extras: `getEpoch()`, `getNetworkStats()`, `listPools()` (one `validators` call: factory
pools by stake, light info), `getPool(id)` (live checks, never cached), `getPools(ids)` (live checks,
cached 5 min for display), `listPositions({ pools? })`, `getMaxStakeable()`. Every write has a
`quote*` twin that signs nothing and returns the exact `transactions`, `fee`, `upfront` (see Fees)
and `warnings`.

Every write takes `expected`: the transactions the user confirmed. The write plans again with fresh
reads and refuses with `quote-changed` (and the new `details.transactions`) when anything differs, for
example when an unstaked balance unlocked between the quote and the click.

Refusals are `NearStakingError` with a `code`: `wrong-chain`, `no-provider`, `invalid-amount`,
`below-minimum` (0.001 NEAR), `pool-required`, `pool-not-allowed` (+ `refusals`), `exceeds-staked`,
`timer-reset-refused`, `max-fee-exceeded`, `nothing-staked`, `not-withdrawable` (+ `details.unlock`),
`nothing-to-claim` (+ `details.soonest`), `unknown-request`, `quote-changed`, `invalid-config`. A
write that does not fit the balance throws core's `InsufficientFundsError`.

## Fees

NEAR buys a transaction's whole prepaid gas when it accepts it, at
max(gas price, `min_gas_purchase_price`): 10^9 yoctoNEAR per gas on mainnet since protocol 88, ten
times the 10^8 gas price. The unburnt part comes back a few blocks later. So a 50 Tgas unstake needs
about 0.055 NEAR on the account even though it finally costs about 0.0005 NEAR. Quotes carry both:

- `upfront`: what the node holds back besides the deposit (Σ gas × the purchase price). Every
  balance check uses it: `stake` needs `amount + upfront + reserve ≤ balance − locked − storage`,
  unstakes and claims need `upfront`.
- `fee`: the upper bound of what is finally paid (Σ gas × gas price + 10 %, the margin wallet-near's
  estimate uses), so `maxFee: quote.fee` passes on a wallet-near account. The module checks
  `maxFee` itself too (`max-fee-exceeded`), because wallet-selector adapters ignore it.

`min_gas_purchase_price` is read from `EXPERIMENTAL_protocol_config` (cached 10 min); a node that
cannot answer gets the mainnet value. `stake` leaves at least the upfront gas of one unstake on the
account (`quote.reserve`), so a stake can always be left without a top-up.

## Timing

- An epoch is 43 200 block heights, **about 6.9 h** on mainnet (measured from the chain at every
  `getEpoch`; 12 h is wrong).
- An unstake unlocks at epoch current + 4: **about 21–28 h**, depending on where in the epoch it
  lands. Quotes carry `unlock` with `earliestEpoch` (current + 4), `latestEpoch` (current + 5, in case
  the transaction lands after the epoch ends) and their dates.
- **Every new unstake restarts the 4-epoch timer for the account's whole unstaked balance in that
  pool.** Such an unstake is refused (`timer-reset-refused`) unless the call passes
  `allowTimerReset: true`; the quote then says so (`resetsTimer`, warning `resets-unbonding-timer`).
  An amount below 0.001 NEAR next to a balance still unbonding is refused even then, and dust stake
  never makes a pool "the only pool with stake". When the unstaked balance is already unlocked, the
  unstake withdraws it first in the same transaction (`withdrawsFirst`, warning
  `withdraws-unlocked-first`), so it is never locked again.
- The pool exposes only `can_withdraw`, not the unlock epoch. Positions in unbonding carry an estimate
  (`current + 1 … current + 4`), or, with `history`, the exact epoch: the last unstake's block, its
  epoch, + 4 (`source: 'history'`). An unstake in the last 3 heights of an epoch may have run in the
  next one (the pool's receipt runs a block or more after the transaction), so it is dated as a
  two-epoch range. If the chain says it is still locked after that epoch, the module trusts the
  chain and falls back to the estimate.
- Pools leave 1–10 yoctoNEAR of share-rounding dust in `unstaked` (most delegators have some).
  Balances below 0.001 NEAR (`UNSTAKED_DUST`) are not requests, not claims and never trigger the
  withdraw-first batch.

## APR

From the protocol's own data: `validator_reward_paid_prev_epoch` ÷ the pool's stake, annualized by
the measured epoch length (ratio in bigint fixed point), times (1 − the pool's fee). A pool with no
reward entry yet (new in the set) gets the network average after its fee, with warning
`apr-network-fallback`. The network average is Σ rewards ÷ Σ stake over the current validators,
`treasury.near` excluded (it takes the protocol's ~10 % share). On 2026-11-08: network 5.03 % gross,
astro-stakers (1 % fee) 5.01 %, figment (10 %) 4.53 %. `enrich` overrides it.

## Safety

- **Pool allow-list**, read fresh for every stake:
  1. `pools` lists it (or is `'any'`);
  2. its id has a staking-pool factory suffix (`*.poolv1.near`, `*.pool.near`; testnet
     `*.pool.f863973.m0`), with one name segment before it. This is local: no RPC answer can change
     it, and other ids get no RPC call at all. `lst-pool.near` (in the validator set, its own code, no
     `is_staking_paused`) and `meta-pool.near` are refused here;
  3. the account exists and runs one of the pinned staking-pool builds (`KNOWN_POOL_CODE_HASHES`: the
     four builds every factory pool in the current and next sets ran on 2026-11-08) or one in
     `codeHashes`. Unknown code is never called by `getPool`;
  4. `is_staking_paused` answers `false` (a missing method, an error or a non-boolean is
     `pause-unknown`, never "not paused");
  5. the fee is well-formed and at most `maxFee`: `get_reward_fee_fraction` for core-contracts pools
     (`*.poolv1.near`); for the staking-farm builds of `*.pool.near`, `get_pool_summary`, and the
     higher of the current fee and the one already scheduled for the next epoch (`nextFee`);
  6. it is in the current and next validator sets (unless `allowInactive`), with `minUptime` if set.
- **Exits are always possible from a known pool.** Unstake and claim check only 2 and 3, so users can
  leave a pool that was paused, raised its fee (an owner can raise it to 100 % at any time; positions
  warn with `pool-fee-above-max`) or left the set. A `*.pool.near` pool that upgraded itself to code
  the `pool.near` factory allows (`is_contract_allowed`) can still be left. `withdraw` pays the
  caller only.
- The module builds function calls on the checked pool only: `deposit_and_stake`, `unstake`,
  `unstake_all`, `withdraw_all`. Never transfers, keys, `Stake` actions or token calls.
- `stake` sends exactly `amount` and requires `amount + upfront + reserve ≤ balance − locked − storage`.
- Policies: the transactions go to the pool account; an `allowlist` must include it.

## Activity

`describeActivity` recognizes the wallet's own calls on factory pools: `deposit_and_stake` /
`deposit` / `stake*` (stake), `unstake*` (unstake; "Withdrew and requested unstake" with
`withdraw_all` in the same transaction), `withdraw*` (claim, with the NEAR the pool sent back from
the receipts, its log, or the indexer's transfer). `ping`, owner methods, other contracts and other
signers return null.

## Testing

- `pnpm test`: an in-memory node seeded with answers recorded on mainnet (`fixtures/rpc/mainnet.json`);
  every allow-list refusal, including a lying RPC (a foreign validator with a 1 % fee, a fake code hash,
  a missing or failing pause method, malformed fees, a scheduled fee); stake amount math against the
  reserve and the upfront gas (the audit's fresh-account delivery);
  unstake batches and timer resets; claims with and without `sendTransactions`; `expected` mismatches;
  epochs with skipped and pruned heights; APR in bigint; conformance with recorded mainnet
  transactions and negatives.
- `pnpm verify:live [rpcUrl]`: view calls only. Epoch, validator set and APRs, verdicts on real pools
  and foreign contracts, then positions and every write planned as real delegators found with
  `get_accounts` (one in unbonding, one with an unlocked balance next to stake). `NEAR_HISTORY=1` also
  dates an unlock through nearblocks. Nothing is signed.
- `node scripts/capture-fixtures.mjs`: recaptures the activity fixtures and the recorded RPC answers.
