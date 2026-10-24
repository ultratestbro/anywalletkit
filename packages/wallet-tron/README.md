# @anywalletkit/wallet-tron

Tron accounts at `m/44'/195'/0'/0/i` (BIP-44 — the TronLink default), pinned by golden
vectors in `@anywalletkit/conformance`. No tronweb: the full-node HTTP API builds
`raw_data`, the account checks it, simulates it, signs `txID` with noble secp256k1
and broadcasts.

```ts
import WalletManagerTron from '@anywalletkit/wallet-tron'

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

## Memo (`raw_data.data`)

`transfer({ …, memo })`, `{ to, value, memo }` and contract calls with `memo` attach
the text as protobuf field 10 of the node-built `raw_data`. The record is spliced at
its canonical position (after `expiration`, before `contract`) so the `txID` we sign
equals the one java-tron recomputes from its own re-serialization; the JSON broadcast
carries the same bytes as `raw_data.data` (hex). The memo fee (`getMemoFee`, 1 TRX)
and the extra bandwidth show up in `estimateFee`, and `describeTransaction` reports
the memo with a `memo-fee` warning. Memos are capped at 512 UTF-8 bytes; attaching
one to a transaction that already carries `raw_data.data` is refused.

## Signers

Accounts sign through a secp256k1 `Signer` from `@anywalletkit/core`: the seed path
uses a `LocalSigner` (zeroized on `dispose()`); `new WalletManagerTron(signer)` wraps
an external one (hardware, MPC, backend). Transactions ask for `ecdsa-recoverable`
over `sha256(raw_data)` with context `tron-tx`, TIP-191 messages with `tron-message`.
A derivable `SeedSigner` at `m/44'/195'/0'/0` yields `getAccount(i)` children; any
other signer is `getAccount(0)` only. `WalletAccountTron.fromPrivateKey(…)` keeps the
raw-key shape.

## Activity history

`createTronHistory` is the chain's `HistorySource` (`@anywalletkit/core`) over TronGrid.

```ts
import { createTronHistory } from '@anywalletkit/wallet-tron/history'

const history = createTronHistory({ apiKey: process.env.TRONGRID_KEY })
const page = await history.listActivity('TVSz6xJL2M53HDZyFTeDcGCmEDdwmU4zbv', { limit: 25 })
const older = await history.listActivity(address, { cursor: page.cursor })
const one = await history.getTransaction(page.items[0].hash, address)
history.explorerTxUrl(one.hash) // https://tronscan.org/#/transaction/…
```

| option | default | notes |
|---|---|---|
| `apiUrl` | `https://api.trongrid.io` (shasta / nile roots by `network`) | Any TronGrid-compatible host. |
| `apiKey` | none | `TRON-PRO-API-KEY`. Keyless TronGrid allows **1 request/s per endpoint** (it answers `request rate exceeded the allowed_rps(1)`). |
| `network` | `mainnet` | `tron:0x2b6653dc` / shasta / nile. |
| `rateLimit` | 1 rps keyless, 10 with a key | |
| `fetch`, `timeoutMs` | global, 15 000 | |

**Lists.** `GET /v1/accounts/{a}/transactions` and `GET /v1/accounts/{a}/transactions/trc20`, both with `limit`, `order_by=block_timestamp,desc`, `max_timestamp` (inclusive, ms) and `min_timestamp` when `since` is given, merged by txID: a `TriggerSmartContract` row plus its TRC-20 rows is one `ChainTx` whose token legs come from the TRC-20 rows (`token` = contract, `standard: 'trc20'`, `symbol`, `decimals` from `token_info`). A transfer known only from the TRC-20 list (someone else's call that moved tokens to the address) is a row of its own: `confirmed`, no `fee`, no `call`, no `block`. `TransferContract` → native transfer and `nativeValue`; `TransferAssetContract` → a transfer with the TRC-10 id as `token`; `TriggerSmartContract` → `call.to` = contract (base58), `call.selector` = first 4 bytes of `data`, `call.data` = `0x` + data, `call.method = 'transfer'` for `a9059cbb`, `nativeValue` = `call_value`; other system contracts (freeze, vote, delegate…) → `call.method` = contract type, `call.to` = receiver or the owner. `internal_transactions` with TRX call values become native transfers. `fee` = `ret[0].fee` (falls back to `net_fee + energy_fee`), `status` from `contractRet`, `block` = `blockNumber`.

**Cursor.** The two lists cannot share a fingerprint, so pages are time windows: every row above the newest "last row" of a list that came back full is complete across both lists and is emitted; the cursor is base64 JSON `{ v: 1, w, x, e }` — `max_timestamp` for the next page, the txIDs already emitted at exactly `w`, and the lists that are finished. A short list is finished only once every row it returned has been emitted.

**Single transaction.** `POST /wallet/gettransactionbyid` + `POST /wallet/gettransactioninfobyid` (two requests): exact `fee`, `status` from `receipt.result`, block / time from the info, TRC-20 legs decoded from `Transfer` logs (symbol / decimals unknown there). The info endpoint is **not** called while listing — the fee of a TRC-20-only row stays undefined (it was paid by the other party), the fee of the address's own transactions is already in the list row.

Fixtures in `test/fixtures/history/` were captured on 2026-10-14 from `api.trongrid.io` (keyless, paced): the test wallet's `/transactions` page (TRX in / out, TRC-10 airdrops) and its empty `/trc20` page, plus — because the test wallet has no TRC-20 or contract activity — the pages of `TCanhfMgr9RsFRoxkJ8YkJD8Faha85a14p` (a counterparty of the wallet: USDT `transfer` via `TriggerSmartContract`, TRC-20 rows) and the full-node `gettransactionbyid` / `gettransactioninfobyid` of that USDT transfer. No protocol module recognizes Tron transactions yet, so there is no recognizer cross-check.
