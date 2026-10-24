# @anywalletkit/wallet-near

[![npm](https://img.shields.io/npm/v/@anywalletkit/wallet-near?label=npm)](https://www.npmjs.com/package/@anywalletkit/wallet-near)

NEAR accounts at `m/44'/397'/i'` (SLIP-10 ed25519 — the NEAR Wallet / `near-seed-phrase`
path; index 0 is what every NEAR wallet derives), pinned by golden vectors in
`@anywalletkit/conformance`. No near-api-js: borsh is hand-written against the nearcore
schema (byte-for-byte checked against `@near-js/transactions`), the node answers JSON-RPC,
the account signs `sha256(borsh(tx))` with noble ed25519 and broadcasts with `send_tx`.

## Install

```sh
npm install @anywalletkit/wallet-near
# or: pnpm add @anywalletkit/wallet-near  ·  yarn add @anywalletkit/wallet-near
```

On npm: [@anywalletkit/wallet-near](https://www.npmjs.com/package/@anywalletkit/wallet-near), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

```ts
import WalletManagerNear from '@anywalletkit/wallet-near'

const wallet = new WalletManagerNear(seedPhrase, { provider: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'] })
const account = await wallet.getAccount(0)          // implicit account: 64-hex id = the public key
await account.transfer({ recipient: 'alice.near', amount: 10n ** 24n })                              // 1 NEAR (yocto)
await account.transfer({ token: 'usdt.tether-token.near', recipient: 'alice.near', amount: 1_000_000n, memo: 'rent' }) // NEP-141
await account.sendTransaction({ receiverId: 'wrap.near', actions: [{ functionCall: { methodName: 'near_deposit', args: {}, gas: 30n * 10n ** 12n, deposit: 10n ** 24n } }] })
const sig = await account.sign('hello')             // "ed25519:<base58>" over the raw bytes
const nep413 = await account.signNep413({ message, nonce, recipient: 'intents.near' }) // what NEAR Intents / dApps ask for
const named = await wallet.getNamedAccount('alice.near') // same key, bound to a named account
wallet.dispose()
```

## What happens before a signature

Every `signTransaction` / `sendTransaction` / `transfer` goes through the same gate:

1. **Build**: `signerId` / `publicKey` are the account's; `nonce` = access-key nonce + 1 and
   `blockHash` = the latest final block come from the node (so `needsNetwork` is true).
2. **Hard checks** (`UnsafeTransactionError`, with a `code`): the signer and key are this
   account; at least one action; no *dangerous* action — AddKey, DeleteKey, DeleteAccount,
   DeployContract, Stake, CreateAccount, global-contract actions, SignedDelegate — unless
   `allowDangerousActions: true`; a valid receiver id; prepaid gas ≤ 300 Tgas; fee ≤
   `transactionMaxFee` when set.
3. **Preflight** (`SimulationError`, off with `simulate: false`) — NEAR has no dry-run RPC, so
   this is what makes a transaction fail *before* a fee is paid: the signer account and its
   access key exist and allow the call, the spendable balance (total − locked − storage) covers
   deposits + fee, a named recipient exists (an implicit one may be created, for ≥ 0.002 NEAR),
   the NEP-141 balance covers an `ft_transfer`, the recipient is registered on the token or a
   `storage_deposit` rides along.
4. **Fee estimate** (upper bound: prepaid gas counts in full; unused gas is refunded; a native
   transfer that creates an implicit account adds the protocol's ~0.007 NEAR creation charge —
   measured on mainnet, not derivable from gas) and the `transferMaxFee` / `transactionMaxFee` cap.

Measured on mainnet (2026-10-10): `ft_transfer` 11.6 Tgas / 0.00041 NEAR; native transfer creating
the recipient 15.9 Tgas / 0.0071 NEAR.

`describeTransaction(tx)` tells you what a transaction does, offline: `near-transfer`,
`ft-transfer` (recipient / amount / memo decoded from the args), `ft-storage-deposit`,
`function-call`, `batch`, or the dangerous kinds — with warnings (`dangerous-action`,
`full-access-key`, `zero-amount`, `self-transfer`, `high-gas`, `unknown-method`,
`invalid-account`). `account.describeTransactionOnline(tx)` adds `implicit-new-account`.

## NEP-141 tokens

`transfer({ token, recipient, amount, memo })` sends `ft_transfer` with 1 yoctoNEAR and 30 Tgas.
When the recipient is not registered on the token (`storage_balance_of` is null) a
`storage_deposit` for `storage_balance_bounds.min` (0.00125 NEAR on most tokens) is prepended
in the same transaction. `getTokenBalance(token)` is `ft_balance_of`.

## Accounts

An implicit account exists from the first NEAR it receives; an account holding only tokens and
no NEAR cannot sign (nothing pays gas) — `simulateTransaction` reports that. A named account
(`alice.near`) that lists this key as a full-access key works through `getNamedAccount`.
`getBalance()` is the total; `getAvailableBalance()` is what can be spent.

## Network

`provider` is one or more JSON-RPC urls (or custom transports); a list fails over in order,
except for definitive node answers (unknown account, invalid transaction) which are returned
as they are. `rpc.mainnet.near.org` is rate-limited and deprecated for production — use
FastNear / a provider / your own proxy. CAIP-2: `near:mainnet` (default) or `near:testnet`.

## Activity history

`createNearHistory` is the chain's `HistorySource` (`@anywalletkit/core`) over the nearblocks API, optionally sharpened by an archival RPC.

```ts
import { createNearHistory } from '@anywalletkit/wallet-near/history'

const history = createNearHistory({ apiKey: process.env.NEARBLOCKS_KEY, rpcUrl: 'https://archival-rpc.mainnet.near.org' })
const page = await history.listActivity('fc647e203e0e099212485017b78a0e77dc330019d4b532a4d44408adc0bfd9a1', { limit: 25 })
const older = await history.listActivity(address, { cursor: page.cursor })
const one = await history.getTransaction(page.items[0].hash, address)
history.explorerTxUrl(one.hash) // https://nearblocks.io/txns/…
```

| option | default | notes |
|---|---|---|
| `nearblocksUrl` | `https://api.nearblocks.io` (`api-testnet.nearblocks.io`) | |
| `apiKey` | none | Bearer key. Keyless nearblocks is limited to a few requests per minute. |
| `rpcUrl` | none | `EXPERIMENTAL_tx_status` for `getTransaction`. Must be **archival** for anything older than a few days: `rpc.mainnet.near.org` answered `UNKNOWN_TRANSACTION` for a two-week-old hash, `archival-rpc.mainnet.near.org` served it. |
| `network` | `mainnet` | `near:mainnet` / `near:testnet`. |
| `rateLimit` | 0.1 rps (6/min) keyless, 5 with a key | nearblocks requests per second; a page needs two. |
| `fetch`, `timeoutMs` | global, 15 000 | |

**Lists.** `GET /v1/account/{id}/txns?per_page=&order=desc&cursor=` (receipt-level rows, asked for twice the limit since a transaction usually has a call and a refund receipt) and `GET /v1/account/{id}/ft-txns?per_page=&order=desc&cursor=` (NEP-141 movements), grouped by `transaction_hash`. nearblocks writes large yoctoNEAR values as JSON numbers; bodies go through `parseJsonPreservingBigInts`, which re-quotes 16+ digit integer literals before `JSON.parse` so they stay exact, while values nearblocks had already rounded to a double (`7e+23`) are used as-is and flag the row `raw.approximate`. `delta_amount` of NEP-141 rows is a string and always exact.

**Mapping.** Receipt rows whose predecessor is `system` (gas refunds) carry no transfers. `TRANSFER` actions and `FUNCTION_CALL` deposits (other than the NEP-141 one-yoctoNEAR formality) become native transfers predecessor → receiver; the first non-transfer action of the receipt addressed to someone else becomes `call` (`to` = receiver, `method`, `programs` = every method in order). NEP-141 rows become `nep141` transfers with the contract as `token`, `symbol` / `decimals` from `ft` (an `ft_transfer_call` into `intents.near` is own → `intents.near`, what `@anywalletkit/protocol-swap2-near-intents` looks for). `status` from `outcomes.status`, `fee` from `outcomes_agg.transaction_fee`, `block` = the lowest `block_height` of the group, `time` from the transaction's `block_timestamp`.

**Cursor.** Base64 JSON `{ v: 1, tx, ft }`: the `id` / `event_index` of the last consumed row of each list (`''` = not started, `null` = exhausted) — nearblocks' `cursor=` is a keyset, so the page can take the top `limit` transactions by block time plus ties and resume each list exactly where it stopped; a list that came back short and fully consumed is not asked again. Receipts of one transaction share the transaction's `block_timestamp`, so a transaction is never split across pages (an NEP-141 row carries its receipt's block time and may land one page later as a row of its own).

**Single transaction.** `GET /v1/txns/{hash}` (transaction-level actions, signer / receiver, `receipts[].fts` with **double** deltas → `raw.approximate`). With `rpcUrl`, `EXPERIMENTAL_tx_status(hash, signer)` rebuilds the row exactly: native legs from `Transfer` / `FunctionCall` deposits (delegate actions unwrapped, so `call.to` is the real receiver), NEP-141 legs from receipt logs (`EVENT_JSON` nep141 `ft_transfer` / `ft_mint` / `ft_burn` and the legacy `Transfer N from A to B` line `wrap.near` emits), `fee` = Σ `tokens_burnt`, `status` from `Failure`; `raw.rpc` holds the result. An RPC that does not know the hash or is down leaves the nearblocks row in place.

Fixtures in `test/fixtures/history/` were captured on 2026-10-14 from `api.nearblocks.io` (keyless) and `archival-rpc.mainnet.near.org`: the test wallet's `/txns` page (a NEAR send with its refund receipt, a `storage_deposit` + `ft_transfer` call, a receive from `intents.near`) and its empty `/ft-txns`, plus — because the test wallet has no NEP-141 rows — the `/txns`, `/ft-txns`, `/v1/txns/{hash}` and RPC `EXPERIMENTAL_tx_status` of the NEAR Intents module's fixture transaction `Fdk3i7f9…` (20.5 wNEAR `ft_transfer_call` into `intents.near` by `b1633df6…`). `test/history.test.ts` checks that the near-intents module describes both the list row and the RPC-refined row as `Bridged wNEAR`.
