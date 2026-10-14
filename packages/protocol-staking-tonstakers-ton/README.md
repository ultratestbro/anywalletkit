# @forgewallet/protocol-staking-tonstakers-ton

A simple package that lets `@forgewallet/wallet-ton` wallet accounts stake
through [Tonstakers](https://tonstakers.com): stake GRAM → tsTON, exit
instant / standard / best-rate, track payout bills, read rates, APY and
earnings.

Built as the **third implementation of the proposed `StakingProtocol` type**
for `@forgewallet/core` — after
Lido (ETH
liquid staking) and
SSV (token
staking with a cooldown) — and the first one off EVM. The base class in
`src/staking-protocol.js` is the same file, byte-identical; a TON liquid
staking protocol fitting it is the point: the type is chain-agnostic.

The mechanics are extracted from a production wallet (React Native/Hermes)
where every flow was exercised with real funds.

## What Tonstakers and tsTON are

The Open Network's native token is **GRAM** (Toncoin was renamed Gram on
2026-06-15; the chain keeps the TON name). [Tonstakers](https://tonstakers.com)
is TON's largest liquid-staking pool (~128M GRAM, ~140k stakers): the pool
contract lends deposited GRAM to validators, and **tsTON** is the non-rebasing
receipt jetton whose GRAM value grows with the pool's rewards — the rate is
the pool's balance over the jetton supply and moves once per validation
round (~18h). Exits burn tsTON in one of three modes: **standard** (paid now
from the pool's free liquidity when there is enough, otherwise a payout bill
settled after the round), **instant** (paid now or the message bounces —
never a bill), **best rate** (always a bill, settled at the round-end
projected rate). Bills are NFTs the pool pays out by itself; there is nothing
to claim.

## Usage

```js
import WalletManagerTon from '@forgewallet/wallet-ton'
import TonstakersProtocolTon from '@forgewallet/protocol-staking-tonstakers-ton'

const wallet = new WalletManagerTon(seed, { tonClient: { url: 'https://toncenter.com/api/v2/jsonRPC' } })
const account = await wallet.getAccount(0)

const tonstakers = new TonstakersProtocolTon(account, {
  partnerCode: 0x…n // optional: Tonstakers partner code for referral attribution
})

// Stake — tsTON lands at the pool rate; the message carries +1 GRAM the pool refunds
const { hash, fee } = await tonstakers.stake({ amount: 10n ** 9n })

// Exit: standard (default), instant (fill-or-kill) or bestRate (round-end rate)
await tonstakers.requestWithdrawal({ amount: 10n ** 9n, mode: 'instant' })

// Bills waiting for their round (settled automatically — nothing to claim)
const { requests, pendingAmount } = await tonstakers.getWithdrawalRequests()

// Views
await tonstakers.getStakedBalance()   // { balance: tsTON, rate: GRAM per tsTON, total: GRAM value }
await tonstakers.getApr()             // 12.86 (percent, tonapi)
```

Tonstakers-specific extras beyond the proposed interface:

```js
await tonstakers.getPoolData()         // halted, depositsOpen, balances, minter, payout collection, rates
await tonstakers.getRates()            // { rate, projectedRate } — GRAM per tsTON, 1e9 fixed
await tonstakers.getInstantLiquidity() // GRAM the pool can pay instant exits from
await tonstakers.getJettonWallet()     // the account's tsTON jetton wallet
await tonstakers.getTokenBalance()     // tsTON held
await tonstakers.getRewards()          // earned GRAM = (rate − weighted entry rate) × tsTON
```

## How it maps onto the proposed interface

| `IStakingProtocol` | Tonstakers |
|---|---|
| `stake({ amount })` | one message to the pool: `amount + 1 GRAM`, body `op 0x47d54391 · query_id 1 · partner code` |
| `requestWithdrawal({ amount, mode })` | burn on the account's tsTON jetton wallet: `1.05 GRAM` attached, body `op 0x595f07bc · amount · owner · {wait_till_round_end, fill_or_kill}` |
| `getWithdrawalRequests()` | the account's payout-bill NFTs in the pool's active payout collections (`claimable` always false) |
| `claimWithdrawals()` | **rejects** — bills are settled by the pool, not claimed |
| `getStakedBalance()` | tsTON balance, `rate` GRAM/tsTON, `total` = GRAM value |
| `getApr()` | tonapi's staking-pool view (the number Tonstakers shows) |

Three honest deviations, documented on the methods rather than papered over:
the exit has **modes** (an extra `mode` option), the second phase is
**automatic** (so `claimWithdrawals` refuses instead of pretending), and
`total` is the position's **value in GRAM** — for a non-rebasing receipt the
GRAM value is the figure that means anything.

## Why it looks the way it does

- **The official SDK only speaks TonConnect** (`tonstakers-sdk` builds and
  sends through a connector; no payload export). Its message builders —
  op codes, fee reserves, payload layout — are ported verbatim and ride the
  account's own `sendTransaction({ to, value, body })`, which signs locally.
- **Friendly addresses on the wire**: the wallet derives the bounce
  flag by parsing the recipient as a *friendly* address, so the module hands
  it `EQ…` forms — a raw `0:…` jetton-wallet address makes it throw
  "Unknown address type". Paid for in production.
- **Pool state is read on-chain** (`get_pool_full_data`, layout verified
  against mainnet), through the account's TonClient with failover across
  configured clients. Public toncenter nodes intermittently answer exit code
  −13 on that getter, so each client gets two tries.
- **Instant exits are pre-checked** against the pool's free balance (the
  contract would bounce them anyway, but a bounce carries no readable reason).
- **REST is decoration**: bills and APY come from the indexes the official
  SDK reads (tonapi, Tonstakers' payout API), overridable or disable-able via
  `config.endpoints`; on-chain flows never depend on them, and `getRewards`
  degrades to null.
- **No `AbortSignal.timeout` / `.any`**, no `process.env` — Hermes and Bare
  friendly. Only mainnet ships with a jetton minter default; testnet carries
  the SDK's pool address and takes the rest via `config.addresses`.

## Configuration

```js
new TonstakersProtocolTon(account, {
  tonClient,     // TonClient | { url, secretKey } | array of either; defaults to the account's
  network,       // '-239' mainnet (default) or '-3' testnet
  addresses,     // { pool, jetton }
  partnerCode,   // referral attribution in stake payloads
  endpoints      // { tonapi, withdrawalPayouts } — null disables the feature
})
```

Mainnet contracts (verified live): pool
`EQCkWxfyhAkim3g2DjKQQg8T5P4g-Q1-K_jErGcDJZ4i-vqR`, tsTON minter
`EQC98_qAmNEptUtPc7W6xdHh_ZHrBUFpw5Ft_IzNU20QAJav`.

## Tests

```
npm test              # offline unit tests (node:test, stubbed TonClient + account)
npm run verify:live   # read-only checks against mainnet (pool getter, jetton wallet, APY, bills, message builders)
```

## Activity

`describeActivity(tx, { own })` labels Tonstakers transactions for a wallet's history, offline and synchronously, against the deployment the instance is configured with (pool + tsTON jetton master; addresses are compared in raw `wc:hex` form, so friendly and raw spellings both match). Three shapes: a message **to the pool** whose op is `OP_STAKE` 0x47d54391 (or undecoded) → `stake` "Staked GRAM" (net GRAM out — the fee reserve the pool returns is netted — tsTON minted in); a **burn** (op `OP_UNSTAKE` 0x595f07bc, read from `call.data` as hex / decimal or from `call.method`) with a tsTON jetton transfer leaving the wallet → `unstake` "Requested unstake" (the destination is the wallet's own jetton wallet, which cannot be known statically, so the jetton movement is the proof); an **incoming** message from the pool carrying GRAM (op 0x0a77535c `tonstake_pool_withdrawal` when decoded, no call of ours) → `claim` "Received unstaked GRAM". Subtitle `"Tonstakers · TON"`, `counterparty` the pool. Anything else — plain GRAM or jetton transfers, other pools — is null.

Fixtures in `fixtures/activity/` are the test wallet's funded run (stake 3 GRAM, unstake 1 tsTON, the settled payout; 2026-09-04 … 10-07, amounts from tonapi events and raw transactions); `negatives/` holds a GRAM transfer in and a USD₮ jetton transfer out.
