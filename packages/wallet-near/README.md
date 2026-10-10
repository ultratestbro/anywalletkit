# @forgewallet/wallet-near

NEAR accounts at `m/44'/397'/i'` (SLIP-10 ed25519 — the NEAR Wallet / `near-seed-phrase`
path; index 0 is what every NEAR wallet derives), pinned by golden vectors in
`@forgewallet/conformance`. No near-api-js: borsh is hand-written against the nearcore
schema (byte-for-byte checked against `@near-js/transactions`), the node answers JSON-RPC,
the account signs `sha256(borsh(tx))` with noble ed25519 and broadcasts with `send_tx`.

```ts
import WalletManagerNear from '@forgewallet/wallet-near'

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
