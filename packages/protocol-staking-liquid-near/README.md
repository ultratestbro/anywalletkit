# @anywalletkit/protocol-staking-liquid-near

Liquid NEAR staking for any NEAR account through the LiNEAR contract family: **LiNEAR**
(`linear-protocol.near`, testnet `linear-protocol.testnet`) and **Rhea rNEAR**
(`lst.rhealab.near`, mainnet only), pinned by account id and code hash. Stake NEAR for the token,
unstake with the exact unlock epoch from the contract (4 or more epochs), withdraw once unlocked and
paid out. Quotes return the exact NEAR transactions, so an external signer (wallet-selector, a
hardware wallet) signs what the user was shown.

```sh
npm install @anywalletkit/protocol-staking-liquid-near @anywalletkit/core
```

`@anywalletkit/wallet-near` comes as a dependency (its RPC client and transaction types).

## Usage

```ts
import { LiquidStakingProtocolNear } from '@anywalletkit/protocol-staking-liquid-near'

// `account`: a wallet-near account, or any IWalletAccount on near:mainnet whose
// sendTransaction(tx: NearTransaction) signs { receiverId, actions } (e.g. a wallet-selector adapter).
const rnear = new LiquidStakingProtocolNear(account, { pool: 'rnear', provider: ['https://free.rpc.fastnear.com'] })

const quote = await rnear.quoteStake({ amount: 730_000_000_000_000_000_000_000n })   // 0.73 NEAR
// quote.transactions: [{ receiverId: 'lst.rhealab.near', actions: [deposit_and_stake, 30 Tgas, 0.73 NEAR] }]
// quote.shares (tokens minted at the current totals), quote.storageFee (0.00125 NEAR kept from a first rNEAR
// stake, else 0), quote.fee (upper bound), quote.upfront (gas the node holds back on acceptance), quote.reserve,
// quote.apr, quote.maxStakeable
await rnear.stake({ amount: 730_000_000_000_000_000_000_000n, expected: quote.transactions })

const exit = await rnear.quoteRequestWithdrawal({ amount: 'all' })    // or token base units
// exit.unlock.earliestEpoch = now + 4; exit.warnings explain timer resets and withdraw-first
await rnear.requestWithdrawal({ amount: 'all', expected: exit.transactions })
// Show exit.unlock.earliestAt. Reads use final blocks, so right after the send they still show the previous
// unlock epoch (0 on a first unstake): read the exact one once it is at least exit.unlock.earliestEpoch.

const { requests } = await rnear.getWithdrawalRequests()              // one per contract: exact unlockEpoch, unlock date
await rnear.claimWithdrawals()                                         // withdraw_all, once unlocked and payable
```

Amounts are bigint: yoctoNEAR for NEAR, token base units (24 decimals) for LINEAR and rNEAR.
`requestWithdrawal` takes **token** units, as the staking interface defines it; the module converts
to NEAR for the contract, whose `unstake` takes NEAR.

## Config

| Option | Default | |
|---|---|---|
| `pool` | — (required) | `'linear'`, `'rnear'`, or `{ contract, symbol, name?, codeHashes, firstStakePaysStorage? }` for another contract with the same interface. `codeHashes` is required: a contract upgrade is refused until the app pins the new build. `firstStakePaysStorage`: the contract keeps its storage fee from an unregistered account's first stake, as rNEAR does; false for a contract that stakes the whole amount, as LiNEAR does. Default: the preset's value when `contract` is a preset's own account (LiNEAR or rNEAR re-pinned after an upgrade), else true. |
| `network` | the account's | `near:testnet` gives testnet, anything else mainnet. rNEAR has no testnet contract (`'unsupported-network'`). |
| `provider` | the wallet-near account's RPC | URL, transport, or a list (failover). An external-signer account has no RPC: pass it. |
| `archivalProvider` | fastnear archival | For the past price behind the APR. |
| `reserve` | 0.02 NEAR | Left on the account by `stake`; never less than one unstake's upfront gas (~0.035 NEAR today). |
| `gas` | 30 Tgas per call | Prepaid gas, all bought upfront at `min_gas_purchase_price` (10^9 on mainnet, 10× the gas price); the unburnt part is refunded a few blocks later. Burnt on mainnet: the contract's receipt of each call 2.4–3.4 Tgas (a plain rNEAR deposit was sent with 30 Tgas), whole transactions 3.4 (rNEAR) to ~11 (LiNEAR). |
| `apr` | — | `() => percent`: an app's or an indexer's figure instead of the estimate. |
| `aprWindowEpochs` | 24 (~7 days) | Window of the price-based APR. |
| `timeoutMs` | 15 000 | Per request, URL providers. |

## Methods

| | What it does |
|---|---|
| `quoteStake` / `stake({ amount, expected? })` | `deposit_and_stake` with exactly `amount`. No "stake everything": pass the amount (`getMaxStakeable()` is the most it can be). |
| `quoteRequestWithdrawal` / `requestWithdrawal({ amount, allowRelock?, allowTimerReset?, expected? })` | `unstake(nearValue)`, or `unstake_all` for `'all'` / the whole balance. An unlocked balance is withdrawn first in the same transaction. |
| `quoteClaimWithdrawals` / `claimWithdrawals({ ids?, expected? })` | `withdraw_all`. `ids` may only be `[poolRequestId(contract)]`. |
| `getWithdrawalRequests()` | One request when the account has NEAR unstaked: `claimable`, `unlockEpoch`, `awaitingLiquidity`, `paused` (withdrawals paused in the contract), `unlock` (epoch and date). |
| `getStakedBalance()` | `balance` = tokens, `rate` = price, `total` = their NEAR value, `unstaked`, `withdrawable`. |
| `getAccountDetails()` | Tokens, value, unstaked, exact `unlockEpoch`, `canWithdraw`, `registered`. |
| `getPoolInfo()` | Price, totals, `paused`, `pausedFeatures` (rNEAR's per-feature pauses), live `codeHash` and `codeHashKnown`, `liquidity`, `kept` (what it cannot pay out), `feeBps`. |
| `getApr()` | The `apr` hook, else the price change over `aprWindowEpochs`, annualized (percent). |
| `getEpoch()` | Height, start, measured duration, estimated end. |
| `getMaxStakeable()` | Spendable − reserve − the stake's upfront gas. |
| `describeActivity(tx, ctx)` | Feed labels: "Staked NEAR for rNEAR · Rhea rNEAR liquid staking", "Requested unstake", "Withdrew unstaked NEAR". |

Helpers: `resolvePool`, `poolRequestId`, `sameTransactions`, `canSendBatch`, `fc`, `readEpoch`,
`epochStartsAt`, `sharesForNear`, `nearForShares`, `aprFromPrices`,
`describeLiquidNearStakingActivity`, `LiquidStakingError` (`code`, `details`), constants
(`LIQUID_PRESETS`, `PRICE_SCALE`, `MIN_EPOCHS_TO_UNLOCK`, `UNSTAKED_DUST`, …).

## What was shown is what is signed

Every quote carries `transactions: NearTransaction[]` (`{ receiverId, actions }`, no signer, nonce
or block hash) and every write sends exactly the transactions its fresh plan builds. Pass the
quote's transactions as `expected`: when the fresh plan differs (the price moved at an epoch
boundary, an unlocked balance appeared and the plan became `[withdraw_all, unstake]`) the write
refuses with `'quote-changed'` and `details.transactions` holds the new plan to show.

The module builds function calls only, to the pinned contract only: `deposit_and_stake`, `unstake`,
`unstake_all`, `withdraw_all`. Never `ft_transfer` or `ft_transfer_call` (none of these contracts
has `ft_on_transfer`: tokens sent that way are lost), never `Transfer`, keys or deploys.

## Timing

- An epoch is ~6.9 hours on mainnet (43 200 heights; `getEpoch().epochMs` is measured), not 12.
- An unstake waits **4 or more epochs** (about 21–35 hours or more). The contract may add epochs for
  large amounts and adds one when the unstake lands after its epoch settlement, so before the unstake
  only the earliest epoch is known (`unlock.latestEpoch = null`, warning `'unlock-may-be-later'`).
  Once the unstake is final, `getAccountDetails().unlockEpoch` is exact and `getWithdrawalRequests()`
  dates it. Reads use final blocks, a couple of blocks behind the send's answer: read right after the
  send, they still show the previous unlock epoch (0 on a first unstake).
- **A new unstake restarts the timer for the whole unstaked balance in that contract.** When it is
  already unlocked, the module withdraws it first in the same transaction
  (`withdrawsFirst`, `'withdraws-unlocked-first'`). When it is still locked, the unstake is refused
  (`'timer-reset-refused'`) unless `allowTimerReset: true`; the quote then says so (`resetsTimer`,
  `'resets-unbonding-timer'`). Below 0.001 NEAR it is refused even then.
- A withdrawal also needs the contract to hold the NEAR: its liquid balance minus what it keeps must
  cover the amount. It keeps 1 NEAR itself (`ERR_NO_ENOUGH_CONTRACT_BALANCE`), and the runtime keeps
  its storage cost (storage_usage × 10^19: ~52 NEAR for rNEAR, ~133 NEAR for LiNEAR; a receipt that
  goes below it fails, reverting the whole transaction), so `kept` = max(1 NEAR, storage cost). The contract's bot brings the
  NEAR back from the validators each epoch. Until then the request is `awaitingLiquidity` and a claim
  refuses with `'awaiting-liquidity'` ("waiting for the protocol's payout"). An unstake that would
  lock such an unlocked balance again refuses with `'relock-refused'` unless `allowRelock: true`.

## Safety

- Writes read the contract fresh first and refuse a code hash that is not pinned
  (`'unknown-contract-code'`) or a contract that is paused (`'contract-paused'`; a missing,
  panicking or non-boolean `is_paused` counts as paused; a transport failure is thrown, never read as
  "not paused"). Both apply to exits too: a paused contract rejects every call anyway.
- rNEAR can also pause single features (`pa_all_paused`: `internal_deposit`, `internal_stake`,
  `internal_unstake`, `internal_withdraw`) while `is_paused` stays false. `getPoolInfo().pausedFeatures`
  lists them, and each write is refused with `'contract-paused'` when a call it would send needs one:
  a stake needs deposits and staking, an unstake unstaking, a claim withdrawals. While withdrawals
  are paused, an unlocked request is not `claimable` (`paused`), and an unstake that would withdraw it
  first is refused with `'relock-refused'` unless `allowRelock: true` (then it is a plain unstake that
  locks it again). 'ALL', a panic or a non-list answer counts as fully paused; a contract without the
  method (LiNEAR) has no per-feature pause.
- Every method that uses the account checks it is on the module's network (`'wrong-chain'`). Writes
  on a read-only account throw `ReadOnlyAccountError` before any read.
- Funds: `amount + upfront + reserve` must fit the spendable balance (amount − max(0, storage − locked)),
  else core's `InsufficientFundsError`. Exits check their `upfront`. `upfront` is Σ gas ×
  max(gas price + 10 %, `min_gas_purchase_price` from `EXPERIMENTAL_protocol_config`, mainnet's 10^9
  when the node cannot say): the node holds it back when it accepts the transaction. `fee` is
  Σ gas × (gas price + 10 %), the margin wallet-near's estimate uses, so `maxFee: quote.fee` passes;
  the module checks `maxFee` itself too (`'max-fee-exceeded'`). Each send gets a copy of the
  quoted transactions.
- No NEP-145 step: `deposit_and_stake` registers the account in the contract itself (on mainnet, an
  implicit account a 1Click delivery had just created staked into LiNEAR this way, unregistered).
  LiNEAR stakes the whole amount. rNEAR keeps `storage_balance_bounds.min` (0.00125 NEAR) of an
  unregistered account's first deposit for that registration and stakes the rest: the module reads
  `storage_balance_of` and the bound live, quotes `shares` for `amount − storageFee`, adds the
  warning `'pays-storage'`, and refuses a first stake below fee + 0.001 NEAR (0.00225 NEAR today)
  with `'below-minimum'`. At or below the fee the contract fails the stake (`amount − fee`
  underflows or stakes nothing) and burns the gas; above it the contract stakes `amount − fee`,
  and the module keeps its 0.001 NEAR minimum for that part, as for any stake.
- `deposit_and_stake` leaves the rounding remainder (a yocto or two) unstaked. Balances at or below
  `UNSTAKED_DUST` (10^6 yocto) are treated as empty, so they never produce a request or a withdraw.

## Pinned contracts (checked on mainnet / testnet, 2026-11-08)

| | Contract | code_hash | Token |
|---|---|---|---|
| LiNEAR | `linear-protocol.near` (v1.6.2) | `5LiDVDd1gh7ofVNbiA9VXrWwkv2m8tw46jZqYeuoC3SG` | LINEAR, 24 decimals, fee 6 % (`linear.sputnik-dao.near`) |
| LiNEAR testnet | `linear-protocol.testnet` | `8Bby4ofnYGtudd3PinKZ1KyvmUKJVyxmfC99ZccRDVDv` | LINEAR |
| Rhea rNEAR | `lst.rhealab.near` (v1.0.2) | `EPLT4C61pkVYf5Km6dC4X9x5PMo6rfBwuEwo7vgKpmuv` | rNEAR, 24 decimals, fee 5 % (`ref-finance.sputnik-dao.near`) |

Both run the same interface: `ft_price`, `get_summary`, `get_account_details`, `is_paused`,
`get_beneficiaries`, `storage_balance_of`, `storage_balance_bounds`; `deposit_and_stake`,
`unstake(NEAR)`, `unstake_all`, `withdraw_all`. rNEAR adds `pa_all_paused` (per-feature pauses) and
keeps the storage fee from a first stake. Neither has `get_num_epoch_to_unstake`, `instant_unstake`
or `ft_on_transfer`.

Meta Pool stNEAR is a different contract family and is not in this package.

## APR

Without the `apr` hook: `ft_price` now and `aprWindowEpochs × 43 200` heights earlier (archival
RPC; a skipped height reads the next block), annualized by the two blocks' timestamps:
`(p1 / p0 − 1) × year / Δt × 100`, in 10^12 fixed point. The price already nets the protocol fee
(it is minted to the beneficiaries). When the archival RPC fails, a 2-epoch window on the regular
RPC. Cached 10 minutes. On 2026-11-08 over 7 days: LiNEAR ≈ 4.7 %, rNEAR ≈ 4.4 %.

## Testing

- `pnpm test`: an in-memory node (contract math from the LiNEAR source), every refusal, the
  transaction shapes, `expected`, the liquidity checks, the APR math, the epoch clock, conformance,
  and recorded mainnet transactions (LiNEAR and rNEAR stake, unstake, unstake_all, withdraw,
  withdraw_all; negatives: token transfers, a lone `storage_deposit`, Meta Pool, the operator bot).
- `node scripts/verify-live.mjs [rpc] [archival]`: view calls only. Both contracts against their
  pins, the epoch, the APR, and every write planned for real holders (one in unbonding per contract).
- `node scripts/capture-fixtures.mjs`: re-captures the activity fixtures with `EXPERIMENTAL_tx_status`.
