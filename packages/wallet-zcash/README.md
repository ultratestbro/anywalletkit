# @anywalletkit/wallet-zcash

[![npm](https://img.shields.io/npm/v/@anywalletkit/wallet-zcash?label=npm)](https://www.npmjs.com/package/@anywalletkit/wallet-zcash)

Zcash **transparent** accounts for Any Wallet Kit — BIP-44 `m/44'/133'/0'/0/i`,
`t1…` addresses (the transparent receiver Zashi, YWallet, Ledger and Trezor derive
from the same seed). Pure `Uint8Array`, `@noble` / `@scure` only, runs in Hermes.

## Install

```sh
npm install @anywalletkit/wallet-zcash
# or: pnpm add @anywalletkit/wallet-zcash  ·  yarn add @anywalletkit/wallet-zcash
```

On npm: [@anywalletkit/wallet-zcash](https://www.npmjs.com/package/@anywalletkit/wallet-zcash), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

```ts
import WalletManagerZcash from '@anywalletkit/wallet-zcash'

const wallet = new WalletManagerZcash(seedPhrase, {
  client: [
    { type: 'blockchair' },                                                   // public, no key
    { type: 'blockbook-http', clientConfig: { url: 'https://zec-blockbook.nownodes.io', headers: { 'api-key': KEY } } },
  ],
  maxFee: 100_000n,                                                           // zatoshi ceiling (default 1 000 000 = 0.01 ZEC)
})
const account = await wallet.getAccount(0)

const preview = await account.describeTransaction({ to: 't1…', value: 5_000_000n })
//   { kind: 'zcash-transfer', version: 5, consensusBranchId, inputs, outputs: [{ role: 'recipient' | 'change' }],
//     fee, conventionalFee, size, lockTime, expiryHeight, txid, warnings }

await account.transfer({ recipient: 't1…', amount: 5_000_000n })             // zatoshis
await account.sendTransaction({ to: 't1…', value: 5_000_000n, fee: 20_000n }) // explicit fee (still ≤ maxFee)
const hex = await account.signTransaction({ to: 't1…', value: 5_000_000n })   // sign only
const max = await account.getMaxSpendable()                                   // sweep amount after fee
wallet.dispose()
```

## What a spend is

A **v5 transaction** (ZIP-225) with transparent inputs and outputs and empty
Sapling / Orchard bundles. Ids and signature hashes follow **ZIP-244**: BLAKE2b-256
digests personalized with the consensus branch id, so a signature is only valid under
the upgrade it was made for. The branch id is the one in force at tip + 1, the block
the transaction lands in (`branchIdForHeight`: NU5 → NU6 → NU6.1 → NU6.3 "Ironwood",
active since block 3 428 143), or `consensusBranchId` from the config when a new
upgrade activates before the package learns its id. On testnet and regtest, whose
upgrades activate at other heights, `consensusBranchId` is required. The expiry is
tip + 1 + `expiryDelta`; without a tip nothing is signed (a transaction with expiry 0
never expires).

Fees are **ZIP-317**: `5000 zatoshis × max(2, logical actions)`, logical actions =
`max(⌈Σ input bytes / 150⌉, ⌈Σ output bytes / 34⌉)` — a 1-in-2-out spend pays
10 000 zatoshis, no fee market. Coin selection is largest-first until the inputs
cover amount + fee; change below the 546-zatoshi dust floor is folded into the fee.
`nLockTime` is the tip height (anti-fee-sniping) and `nExpiryHeight` tip + 40
(ZIP-203), so an unmined transaction expires in under an hour instead of lingering.

The ZIP-244 implementation is pinned by mined mainnet transactions in the tests:
parse → serialize round-trip, txid equality and ECDSA verification of every on-chain
signature over the digest this package computes.

## Safety checks

Before signing **and** before broadcasting (also for caller-supplied raw hex):
fee ≤ `maxFee`, outputs ≤ inputs, exactly one output is the requested recipient /
amount and every other output is our own address. Warnings (not blocks): fee below
the conventional fee (nodes may not relay), fee over 10 % of the amount, dust output,
no change, no expiry.

Shielded destinations are refused by name: unified `u1…`, Sapling `zs1…`, Sprout
`zc…`. Sending **to** a shielded address and receiving on one need a shielded wallet
(note-commitment tree sync + prover) — out of scope for this package.

## Message signing

`sign(message)` is zcashd's `signmessage`: `sha256d("\x16Zcash Signed Message:\n" ‖ len ‖ message)`,
header `31 + recovery` (compressed key), base64. `verify` recovers the key and compares
the P2PKH address.

## Transports

| `type` | Backend | Notes |
|---|---|---|
| `blockchair` | `https://api.blockchair.com/zcash` | public, CORS, UTXOs incl. mempool, raw tx, `push/transaction`; optional `key`; mainnet only |
| `blockbook-http` | any Zcash Blockbook (NOWNodes `zec-blockbook.nownodes.io`, self-hosted) | `/api/v2/{address,utxo,tx,sendtx}`; `headers` for API keys; testnet too |

A list fails over in order; a node's *refusal* of a broadcast is final (not retried on
the next transport) unless an endpoint before it never answered. A broadcast with no
definitive answer (no response, a timeout, a 5xx, an HTML 502) throws
`BroadcastUnknownError` (`maybeSent`, `hash` = the txid computed before sending): do
not spend the coins again. "Already in the mempool / block chain" returns the txid.

## Activity history

`createZcashHistory()` (from `@anywalletkit/wallet-zcash/history`) is a `HistorySource`
over Blockchair: one transaction = one native transfer in the owner's direction;
shielded legs appear only as the transparent value that entered or left.
