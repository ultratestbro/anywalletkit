# @anywalletkit/protocol-staking-liquid-near

Liquid NEAR staking for any NEAR account through the LiNEAR contract family: **LiNEAR**
(`linear-protocol.near`) and **Rhea rNEAR** (`lst.rhealab.near`), pinned by account id and code hash.
Stake NEAR for the token, unstake with the exact unlock epoch from the contract (4+ epochs),
withdraw once unlocked and paid out.

> Status: in development (0.0.0). The API is fixed in the package's `src/types.ts`.

```sh
npm install @anywalletkit/protocol-staking-liquid-near @anywalletkit/core
```

## Usage

```ts
import { LiquidStakingProtocolNear } from '@anywalletkit/protocol-staking-liquid-near'

const rnear = new LiquidStakingProtocolNear(account, { pool: 'rnear', provider: ['https://free.rpc.fastnear.com'] })
const quote = await rnear.quoteStake({ amount: 10n ** 24n })
await rnear.stake({ amount: 10n ** 24n, expected: quote.transactions })
await rnear.requestWithdrawal({ amount: 'all' })     // token units, or 'all'
await rnear.claimWithdrawals()                       // withdraw_all, when unlocked and the contract holds the NEAR
```

## Safety

- Never sends the token with `ft_transfer_call` to the contract: it has no `ft_on_transfer`, so
  tokens sent that way are lost.
- Writes refuse a paused contract (`is_paused`) and a contract whose live code hash is not pinned.
- A withdrawal is offered only when the contract's liquid balance covers it plus its 1 NEAR reserve.
