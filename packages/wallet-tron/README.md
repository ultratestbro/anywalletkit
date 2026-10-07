# @forgewallet/wallet-tron

Tron accounts at `m/44'/195'/0'/0/i` (BIP-44 — the TronLink default), pinned by golden
vectors in `@forgewallet/conformance`. No tronweb: the full-node HTTP API builds
`raw_data`, the account checks it, simulates it, signs `txID` with noble secp256k1
and broadcasts.

```ts
import WalletManagerTron from '@forgewallet/wallet-tron'

const wallet = new WalletManagerTron(seedPhrase, { provider: ['https://api.trongrid.io', 'https://tron-rpc.example'], headers: { 'TRON-PRO-API-KEY': key } })
const account = await wallet.getAccount(0)
await account.transfer({ recipient: 'T…', amount: 1_000_000n })                    // 1 TRX (sun)
await account.transfer({ token: USDT_TRC20, recipient: 'T…', amount: 1_000_000n }) // TRC-20
await account.sendTransaction({ contractAddress, functionSelector: 'approve(address,uint256)', parameters: [...] })
const sig = await account.sign('hello')                                            // TIP-191, 0x + r||s||v (27/28)
wallet.dispose()
```

## What happens before a signature

Every `signTransaction` / `sendTransaction` / `transfer` goes through the same gate:

1. **Hard checks** (`UnsafeTransactionError`, with a `code`): exactly one contract; `owner_address`
   is this account; `ref_block_bytes` / `ref_block_hash` present; `expiration` in the future and
   at most 24 h away; no TRX / TRC-20 transfer to the zero address unless `allowBurn: true`;
   `fee_limit` ≤ `transactionMaxFee` when set.
2. **Simulation** (`SimulationError`, off with `simulate: false`): contract calls run through
   `/wallet/triggerconstantcontract` and the revert reason is ABI-decoded (`Error(string)`,
   `Panic`); TRX transfers check that the balance covers amount + fees.
3. **Fee estimate** and the `transferMaxFee` / `transactionMaxFee` cap.

`describeTransaction(tx)` tells you what a transaction does, offline: `trx-transfer`,
`trc20-transfer`, `trc20-approve`, `contract-call`, `freeze`, `unfreeze` — with decoded
recipient / amount / spender and warnings (`unlimited-approve`, `zero-address`, `memo-fee`,
`expired`). `account.describeTransactionOnline(tx)` adds `unactivated-recipient`.

## Fees

`account.estimateFee(tx)` → `{ bandwidth, energy, trxBurn, breakdown }`, where `trxBurn` is
what the sender actually pays (sun) after staked / free resources:

- **bandwidth** points = serialized size (`raw_data` + protobuf envelope + 65-byte signature)
  + 64-byte result reserve — 268 for a TRX transfer, ~345 for a TRC-20 transfer. Staked
  bandwidth is used first, then the free daily allowance, else `getTransactionFee` sun per point.
- **energy** = `energy_used` of a constant call; what staked energy does not cover is burned
  at `getEnergyFee`. `fee_limit` defaults to energy × price × 1.2 (capped at `transactionMaxFee`).
- **account creation** (TRX transfer to an unseen address): `getCreateNewAccountFeeInSystemContract`
  (1 TRX) plus `getCreateAccountFee` (0.1 TRX) unless staked bandwidth covers the bytes —
  free bandwidth is not accepted for creation.
- **memo** (`raw_data.data`): `getMemoFee` (1 TRX).

`quoteSendTransaction` / `quoteTransfer` return `{ fee: trxBurn, activationFee, estimate }`.
