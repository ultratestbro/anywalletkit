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
// quote.transactions: [{ receiverId: 'lst.rhealab.near', actions: [deposit_and_stake, 100 Tgas, 0.73 NEAR] }]
// quote.shares (tokens minted at the current totals), quote.fee (upper bound), quote.apr, quote.maxStakeable
await rnear.stake({ amount: 730_000_000_000_000_000_000_000n, expected: quote.transactions })

const exit = await rnear.quoteRequestWithdrawal({ amount: 'all' })    // or token base units
// exit.unlock.earliestEpoch = now + 4; exit.warnings explain timer resets and withdraw-first
await rnear.requestWithdrawal({ amount: 'all', expected: exit.transactions })
const { unlockEpoch } = await rnear.getAccountDetails()                // exact, from the contract

const { requests } = await rnear.getWithdrawalRequests()              // one request per contract
await rnear.claimWithdrawals()                                         // withdraw_all, once unlocked and payable
```

Amounts are bigint: yoctoNEAR for NEAR, token base units (24 decimals) for LINEAR and rNEAR.
`requestWithdrawal` takes **token** units, as the staking interface defines it; the module converts
to NEAR for the contract, whose `unstake` takes NEAR.

## Config

| Option | Default | |
|---|---|---|
| `pool` | — (required) | `'linear'`, `'rnear'`, or `{ contract, symbol, name?, codeHashes }` for another contract with the same interface. `codeHashes` is required: a contract upgrade is refused until the app pins the new build. |
| `network` | the account's | `near:testnet` gives testnet, anything else mainnet. rNEAR has no testnet contract (`'unsupported-network'`). |
| `provider` | the wallet-near account's RPC | URL, transport, or a list (failover). An external-signer account has no RPC: pass it. |
| `archivalProvider` | fastnear archival | For the past price behind the APR. |
| `reserve` | 0.02 NEAR | Left on the account by `stake`, for gas. |
| `gas` | stake 100, unstake 50, withdraw 50 Tgas | Prepaid; unused gas is refunded, but the quoted fee is the prepaid upper bound and `getMaxStakeable()` keeps it back. Burnt on mainnet: `deposit_and_stake` ~3.5 Tgas (a plain deposit was sent with 30 Tgas), `unstake_all` 3.5, `withdraw_all` 3.4 (rNEAR) to ~11 (LiNEAR). |
| `apr` | — | `() => percent`: an app's or an indexer's figure instead of the estimate. |
| `aprWindowEpochs` | 24 (~7 days) | Window of the price-based APR. |
| `timeoutMs` | 15 000 | Per request, URL providers. |

## Methods

| | What it does |
|---|---|
| `quoteStake` / `stake({ amount, expected? })` | `deposit_and_stake` with exactly `amount`. No "stake everything": pass the amount (`getMaxStakeable()` is the most it can be). |
| `quoteRequestWithdrawal` / `requestWithdrawal({ amount, allowRelock?, expected? })` | `unstake(nearValue)`, or `unstake_all` for `'all'` / the whole balance. An unlocked balance is withdrawn first in the same transaction. |
| `quoteClaimWithdrawals` / `claimWithdrawals({ ids?, expected? })` | `withdraw_all`. `ids` may only be `[poolRequestId(contract)]`. |
| `getWithdrawalRequests()` | One request when the account has NEAR unstaked: `claimable`, `unlockEpoch`, `awaitingLiquidity`, `unlock` (epoch and date). |
| `getStakedBalance()` | `balance` = tokens, `rate` = price, `total` = their NEAR value, `unstaked`, `withdrawable`. |
| `getAccountDetails()` | Tokens, value, unstaked, exact `unlockEpoch`, `canWithdraw`, `registered`. |
| `getPoolInfo()` | Price, totals, `paused`, live `codeHash` and `codeHashKnown`, `liquidity`, `feeBps`. |
| `getApr()` | The `apr` hook, else the price change over `aprWindowEpochs`, annualized (percent). |
| `getEpoch()` | Height, start, measured duration, estimated end. |
| `getMaxStakeable()` | Spendable − reserve − fee. |
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
  After it, `getAccountDetails().unlockEpoch` is exact; `getWithdrawalRequests()` dates it.
- **A new unstake restarts the timer for the whole unstaked balance in that contract.** When part
  of it is already unlocked, the module withdraws it first in the same transaction
  (`withdrawsFirst`, `'withdraws-unlocked-first'`). When it is still locked, the quote says so
  (`resetsTimer`, `'resets-unbonding-timer'`).
- A withdrawal also needs the contract to hold the NEAR: its liquid balance minus its 1 NEAR reserve
  must cover the amount (`ERR_NO_ENOUGH_CONTRACT_BALANCE` otherwise). The contract's bot brings the
  NEAR back from the validators each epoch. Until then the request is `awaitingLiquidity` and a claim
  refuses with `'awaiting-liquidity'` ("waiting for the protocol's payout"). An unstake that would
  lock such an unlocked balance again refuses with `'relock-refused'` unless `allowRelock: true`.

## Safety

- Writes read the contract fresh first and refuse a code hash that is not pinned
  (`'unknown-contract-code'`) or a contract that is paused (`'contract-paused'`; a missing,
  panicking or non-boolean `is_paused` counts as paused; a transport failure is thrown, never read as
  "not paused"). Both apply to exits too: a paused contract rejects every call anyway.
- Every method that uses the account checks it is on the module's network (`'wrong-chain'`). Writes
  on a read-only account throw `ReadOnlyAccountError` before any read.
- Funds: `amount + fee + reserve` must fit the spendable balance (amount − locked − storage), else
  core's `InsufficientFundsError`. Exits check the fee.
- No NEP-145 step: `deposit_and_stake` creates the account's entry in the contract (on mainnet, an
  implicit account a 1Click delivery had just created staked into LiNEAR this way, unregistered).
  Registration only matters for receiving the token by transfer.
- `deposit_and_stake` leaves the rounding remainder (a yocto or two) unstaked. Balances at or below
  `UNSTAKED_DUST` (10^6 yocto) are treated as empty, so they never produce a request or a withdraw.

## Pinned contracts (checked on mainnet / testnet, 2026-11-08)

| | Contract | code_hash | Token |
|---|---|---|---|
| LiNEAR | `linear-protocol.near` (v1.6.2) | `5LiDVDd1gh7ofVNbiA9VXrWwkv2m8tw46jZqYeuoC3SG` | LINEAR, 24 decimals, fee 6 % (`linear.sputnik-dao.near`) |
| LiNEAR testnet | `linear-protocol.testnet` | `8Bby4ofnYGtudd3PinKZ1KyvmUKJVyxmfC99ZccRDVDv` | LINEAR |
| Rhea rNEAR | `lst.rhealab.near` (v1.0.2) | `EPLT4C61pkVYf5Km6dC4X9x5PMo6rfBwuEwo7vgKpmuv` | rNEAR, 24 decimals, fee 5 % (`ref-finance.sputnik-dao.near`) |

Both run the same interface: `ft_price`, `get_summary`, `get_account_details`, `is_paused`,
`get_beneficiaries`, `storage_balance_of`; `deposit_and_stake`, `unstake(NEAR)`, `unstake_all`,
`withdraw_all`. Neither has `get_num_epoch_to_unstake`, `instant_unstake` or `ft_on_transfer`.

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
