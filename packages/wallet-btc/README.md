# @forgewallet/wallet-btc

Bitcoin accounts on [`@scure/btc-signer`](https://github.com/paulmillr/scure-btc-signer)
(audited by Cure53; pure `Uint8Array`, no `Buffer`, no Node shims):

| `addressType` | Path | Address | Standard |
|---|---|---|---|
| `p2wpkh` (default) | `m/84'/0'/0'/0/i` | `bc1q…` | BIP-84 native segwit |
| `p2tr` | `m/86'/0'/0'/0/i` | `bc1p…` | BIP-86 key-path taproot |

Test networks use coin type `1'` (`tb1…` / `bcrt1…`). Both paths are pinned by the
official BIP-84 / BIP-86 test vectors.

```ts
import WalletManagerBtc from '@forgewallet/wallet-btc'

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
