# @anywalletkit/wallet-btc

[![npm](https://img.shields.io/npm/v/@anywalletkit/wallet-btc?label=npm)](https://www.npmjs.com/package/@anywalletkit/wallet-btc)

Bitcoin accounts on [`@scure/btc-signer`](https://github.com/paulmillr/scure-btc-signer)
(audited by Cure53; pure `Uint8Array`, no `Buffer`, no Node shims):

## Install

```sh
npm install @anywalletkit/wallet-btc
# or: pnpm add @anywalletkit/wallet-btc  ·  yarn add @anywalletkit/wallet-btc
```

On npm: [@anywalletkit/wallet-btc](https://www.npmjs.com/package/@anywalletkit/wallet-btc), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

| `addressType` | Path | Address | Standard |
|---|---|---|---|
| `p2wpkh` (default) | `m/84'/0'/0'/0/i` | `bc1q…` | BIP-84 native segwit |
| `p2tr` | `m/86'/0'/0'/0/i` | `bc1p…` | BIP-86 key-path taproot |

Test networks use coin type `1'` (`tb1…` / `bcrt1…`). Both paths are pinned by the
official BIP-84 / BIP-86 test vectors.

```ts
import WalletManagerBtc from '@anywalletkit/wallet-btc'

const wallet = new WalletManagerBtc(seedPhrase, {
  network: 'bitcoin',
  addressType: 'p2wpkh',                       // or 'p2tr'
  client: [
    { type: 'blockbook-http', clientConfig: { url: 'https://btc1.trezor.io' } },
    { type: 'esplora-http', clientConfig: { url: 'https://mempool.space/api' } }, // fails over in order
  ],
  maxFeeRate: 200,                             // sat/vB ceiling (default 500)
})
const account = await wallet.getAccount(0)

const preview = await account.describeTransaction({ to: 'bc1q…', value: 50_000n })
//   { kind: 'btc-transfer', inputs, outputs: [{ role: 'recipient' | 'change' }], fee, feeRate, vsize, rbf, lockTime, warnings }

await account.transfer({ recipient: 'bc1q…', amount: 50_000n })             // sats
await account.sendTransaction({ to: 'bc1q…', value: 50_000n, feeRate: 12n }) // explicit sat/vB
const hex = await account.signTransaction({ to: 'bc1q…', value: 50_000n })   // sign only
const max = await account.getMaxSpendable()                                  // sweep amount after fee
wallet.dispose()
```

## What a spend is

Coin selection is our own (`selectCoins`, `coinselect.ts`): effective-value
accumulation, largest first; inputs that cannot pay for themselves are skipped;
change below dust (294 sat p2wpkh / 330 sat p2tr) is folded into the fee; at most
`maxInputs` (200) inputs. Fees are `feeRate × vsize` with the standard segwit
weights, estimated with 72-byte signatures so the quote is never below the fee
actually paid.

Transactions signal replace-by-fee (`rbf`, default on) and set `nLockTime` to the
current tip (`antiFeeSniping`, default on when the transport can report the height).

## Safety checks

Before signing **and** before broadcasting — also for caller-supplied raw hex —
every transaction is resolved into a `BtcTxDescription` and must pass:

- fee rate ≤ `maxFeeRate` (`UnsafeTransactionError('fee-rate-too-high')`);
- exactly one output equals the requested recipient + amount, every other output
  is our own change (`'unexpected-output'`, `'recipient-mismatch'`, `'change-not-ours'`);
- `transactionMaxFee` / `transferMaxFee` absolute caps.

Warnings that do not block: `high-fee-rate`, `fee-over-10pct-of-amount`,
`dust-output`, `no-change`.

## Message signing

`sign()` / `verify()` are BIP-137 for p2wpkh accounts (header `39 + recovery`,
base64 — the Electrum / Bitcoin Core encoding). Taproot accounts have no BIP-137
form; `sign()` throws `UnsupportedAddressTypeError` (BIP-322 is not implemented).

## Transports

`blockbook-http` (Trezor Blockbook REST, QuickNode's add-on) and `esplora-http`
(mempool.space, blockstream.info). Requests time out after `timeoutMs` (15 s) and
responses are shape-checked (`NetworkError` otherwise). Pass your own object
implementing `BtcClient` for anything else.

## Activity history

`createBtcHistory` is the chain's `HistorySource` (`@anywalletkit/core`) over Blockbook, reusing `BlockbookClient` (`getAddressPage`, `getTransactionDetails`).

```ts
import { createBtcHistory } from '@anywalletkit/wallet-btc/history'

const history = createBtcHistory({ blockbookUrls: ['https://btc1.trezor.io', 'https://bitcoin.atomicwallet.io'] })
const page = await history.listActivity('bc1q3x8yszvcvjjxqragsh0l6j8rxnhk7pay9hnj5h', { limit: 25 })
const older = await history.listActivity(address, { cursor: page.cursor })
const one = await history.getTransaction(page.items[0].hash, address)
history.explorerTxUrl(one.hash) // https://mempool.space/tx/…
```

| option | default | notes |
|---|---|---|
| `blockbookUrl` / `blockbookUrls` | — | Blockbook roots, tried in order (Cloudflare 403, 5xx, network → next). The Trezor instances (`btc1…5.trezor.io`) sit behind a Cloudflare challenge that blocks non-browser user agents; `bitcoin.atomicwallet.io` and `blockbook.btc.zelcore.io` answered on 2026-10-14. QuickNode's Blockbook add-on speaks the same API. |
| `network` | `bitcoin` | `testnet` / `regtest` CAIP-2 ids; mempool.space testnet links. |
| `pageSize` | the query `limit`, ≤ 100 | Rows per Blockbook page (its max is 1000). |
| `fetch`, `timeoutMs` | global, 15 000 | |

**Endpoint.** `GET /api/v2/address/{a}?details=txs&page=&pageSize=` — Blockbook returns transactions newest first with inputs and outputs (`hex` is dropped). The cursor is base64 JSON `{ v: 1, p, s }`: the next page and the page size the pagination started with (Blockbook clamps out-of-range pages to the last one, so paging stops at `totalPages`). `since` is applied client-side; unconfirmed rows are always kept.

**Mapping.** Inputs the address spent (`ownIn`) and outputs it received (`ownOut`) are summed. Spent inputs → a send: `from` = address, `to` = the first output that is not ours, `nativeValue` = what left to non-own outputs (change ignored, fee separate); every output ours → a consolidation to itself. No spent inputs → a receive: `from` = the first input address (`coinbase` when none), `nativeValue` = `ownOut`. `transfers` is that one native leg, `fee` = `fees`, `status` = `confirmed` once `confirmations ≥ 1` (else `pending`, no `block`), `block` = `blockHeight`, `raw` = the Blockbook transaction plus `ownIn` / `ownOut`.

Fixtures in `test/fixtures/history/` were captured on 2026-10-14 from `bitcoin.atomicwallet.io` for the test address (its 4 transactions: two receives, two sends with change) and `GET /api/v2/tx/{txid}` of one send. No protocol module recognizes Bitcoin transactions, so there is no recognizer cross-check.
