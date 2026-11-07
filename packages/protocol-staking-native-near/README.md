# @anywalletkit/protocol-staking-native-near

Native NEAR staking for any NEAR account: `deposit_and_stake` into the staking pools **your app
allows**, unstake with the 4-epoch unbonding (~28 h at ~6.9 h per epoch), `withdraw_all` once
unlocked. No extra contract, no token.

> Status: in development (0.0.0). The API is fixed in the package's `src/types.ts`.

```sh
npm install @anywalletkit/protocol-staking-native-near @anywalletkit/core
```

## Usage

```ts
import { NativeStakingProtocolNear } from '@anywalletkit/protocol-staking-native-near'

const staking = new NativeStakingProtocolNear(account, {
  pools: ['astro-stakers.poolv1.near'],          // or 'any'
  provider: ['https://free.rpc.fastnear.com'],
})

const quote = await staking.quoteStake({ amount: 10n ** 24n })   // 1 NEAR
// quote.transactions is exactly what stake() sends: show it, then
await staking.stake({ amount: 10n ** 24n, expected: quote.transactions })
await staking.requestWithdrawal({ amount: 'all' })                // [withdraw_all, unstake_all] when unlocked funds wait
// … 4 epochs later …
await staking.claimWithdrawals()                                  // withdraw_all per pool
```

Amounts are yoctoNEAR (bigint).

## Safety

- `pools` is required. Every pool must be a factory pool (`*.poolv1.near` / `*.pool.near`, testnet
  `*.pool.f863973.m0`), checked locally, run a known staking-pool code hash, answer
  `is_staking_paused` with `false` (a missing method is refused), charge at most `maxFee` (10 %), and
  sit in the current and next validator sets.
- `stake` never stakes "everything": the amount is explicit and must leave `reserve` (0.02 NEAR) plus
  the fee on the account.
- An unstake while an unlocked balance waits is sent as `[withdraw_all, unstake]` in one transaction,
  so unlocked NEAR is never locked again. Every new unstake restarts the timer for the pool's whole
  unstaked balance; quotes say so.
