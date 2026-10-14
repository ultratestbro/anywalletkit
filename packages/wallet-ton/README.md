# @forgewallet/wallet-ton

TON accounts at `m/44'/607'/i'` (SLIP-10 ed25519) on Wallet V5R1 — the
derivation Trust Wallet and Ledger use for a BIP-39 phrase, pinned by
golden vectors in `@forgewallet/conformance`. Runtime dependencies: `@ton/core`,
`@ton/crypto`, `buffer` (no `@ton/ton`: the V5R1 contract and the toncenter
client are implemented here, byte-for-byte checked against `@ton/ton` in tests).

```ts
import WalletManagerTon from '@forgewallet/wallet-ton'

const wallet = new WalletManagerTon(seedPhrase, {
  tonClient: [{ url: 'https://toncenter.com/api/v2/jsonRPC', secretKey }],   // fails over in order
  // emulate: {kind: 'tonapi'} is the default (tonapi.io/v2/wallet/emulate, then /traces/emulate);
  // {kind: 'toncenter-v3', url} switches the emulator, false = estimateFee only.
  tonApiKey,                                                                  // optional: Bearer key for tonapi
})
const account = await wallet.getAccount(0)

account.describe({ to: 'UQ…', value: 100_000_000n, body: 'thanks' })         // offline: kind, items, warnings
await account.simulateTransaction({ to: 'UQ…', value: 100_000_000n })         // fees + emulation verdict + risk (what leaves the wallet)
await account.transfer({ recipient: 'UQ…', amount: 100_000_000n })            // 0.1 TON
await account.transfer({ token: USDT_MASTER, recipient: 'UQ…', amount: 1_000_000n, forwardPayload: 'hi' })
await account.sendTransaction([                                               // several messages, ONE external
  { to: 'EQ…', value: 50_000_000n, bodyBoc, stateInit },                      // e.g. an Omniston escrow deploy
  { to: 'UQ…', value: 1n },
])
const receipt = await account.getTransactionReceipt(hash)                     // hash = body hash, via toncenter v3
wallet.dispose()

// Tonkeeper-style 24-word TON mnemonic (not BIP-39): one account, same surface.
const tk = await WalletManagerTon.fromTonMnemonic(words, { tonClient })
```

## Every send

1. Hard checks, before any network call: value > 0, workchain 0/-1 only,
   friendly-address network flag matches `config.network`, `valid_until` =
   now + `validUntilSeconds` (default 60, max 600).
2. Fresh seqno (never cached across sends).
3. Preflight on the zero-signed body: toncenter `estimateFee` (the fee cap)
   and a trace emulation — tonapi by default (`POST /v2/wallet/emulate`,
   falling back to `/v2/traces/emulate`), or a toncenter-v3 `emulateTrace`
   endpoint via `emulate: {kind: 'toncenter-v3', url}`. A non-zero compute exit,
   an aborted transaction, a failed action phase or a failed **first-hop**
   internal message (the operation would bounce) throws `SimulationError`
   **before signing**; failures deeper in the trace are `warnings`. tonapi's
   `risk` is returned as `risk` and a body that would carry the whole balance
   (send mode 128) is refused with `UnsafeTransactionError('drain')` unless
   `allowDrainingTransactions`. `emulate: false` keeps only `estimateFee`;
   `simulate: false` skips the preflight entirely.
4. noble ed25519 over the body hash; the 32-byte seed is the only key material
   and `dispose()` zeroizes it.
5. `sendBoc` of the external (with StateInit when the wallet is not deployed).

## Signers

The account never holds a key. Every signature is a `signer.sign(bytes, {scheme: 'ed25519', context})`
call: `ton-external` over the hash of the V5R1 signing cell (after the preflight, which runs on a
zero-signed body), `ton-message` over raw message bytes (`sign()`, ton_proof). Seed wallets get a
`LocalSigner`; a hardware wallet, MPC node or backend is wrapped with `externalSigner()` from
`@forgewallet/core`:

```ts
const signer = externalSigner({ curve: 'ed25519', publicKey, sign: (payload, { context }) => device.sign(payload) })
const manager = new WalletManagerTon(signer, { tonClient })
const account = await manager.getAccount() // path 'external'; other indexes throw
```

A derivable `SeedSigner` at `m/44'/607'` yields `getAccount(i)` children; a leaf signer (including
`fromTonMnemonic`) is one account. `WalletAccountTon.fromPrivateKey(priv, pub, path)` keeps the
raw-key shape for callers that derive themselves.

## Describe

`describeTransaction(tx)` / `account.describe(tx)` decode TON transfers (text
comments), jetton transfers (`0x0f8a7ea5`: amount, destination, forward
amount/payload, custom payload) and contract calls, also from a prebuilt V5R1
body, with warnings: `zero-value`, `non-bounceable-contract-call`,
`unknown-body`, `large-forward-amount`, `testnet-address` / `mainnet-address`,
`exotic-workchain`.

## Buffer

On import the package installs the `buffer` polyfill as `globalThis.Buffer` if
none exists (`@ton/core` requires the global). Node, and apps that already set
it, are untouched.

## React Native

`@ton/crypto-primitives` resolves its `react-native` build on Metro, which
requires `expo-crypto` (random bytes) at module load and
`react-native-fast-pbkdf2` for the TON-mnemonic import. Install `expo-crypto`
in the app (Expo projects already have it). BIP-39 wallets sign through noble
ed25519 and need neither.

## Activity history

`createTonHistory` is the chain's `HistorySource` (`@forgewallet/core`): tonapi account events first, toncenter v3 as a reduced fallback.

```ts
import { createTonHistory } from '@forgewallet/wallet-ton/history'

const history = createTonHistory({ apiKey: process.env.TONAPI_KEY })
const page = await history.listActivity('UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq', { limit: 25 })
const older = await history.listActivity(address, { cursor: page.cursor })
const one = await history.getTransaction(page.items[0].hash, address)
history.explorerTxUrl(one.hash) // https://tonviewer.com/transaction/…
```

| option | default | notes |
|---|---|---|
| `tonapiUrl` | `https://tonapi.io` (`testnet.tonapi.io`) | `null` disables tonapi. |
| `apiKey` | none | tonapi Bearer key. Keyless tonapi allows ~1 request/s. |
| `toncenterUrl` | `https://toncenter.com` (`testnet.toncenter.com`) | v3 fallback; `null` disables it. |
| `toncenterApiKey` | none | `X-API-Key`. |
| `network` | `mainnet` | `ton:-239` / `ton:-3`. |
| `rateLimit` | 1 rps keyless, 10 with a key | tonapi requests per second (toncenter: 1 keyless, 10 with a key). |
| `fetch`, `timeoutMs` | global, 15 000 | |

**tonapi** (`GET /v2/accounts/{a}/events?limit=&before_lt=`, `GET /v2/accounts/{a}/events/{id}`): one event = one trace, with typed actions. `TonTransfer`, `JettonTransfer`, `JettonMint`, `JettonBurn`, `JettonSwap` (TON / jetton in and out against the DEX router), `SmartContractExec` (`ton_attached`), `DepositStake` / `WithdrawStake` (staker ↔ pool), `Subscribe`, `NftPurchase`, elections become transfers; jetton transfers carry the master as `token`, `standard: 'jetton'`, `symbol` and `decimals` from the action's jetton object. The first contract-level action is the `call`: `SmartContractExec` → `to` = contract, hex op in `data`, named op in `method`; `JettonSwap` → router / `swap`; a jetton sent to a contract with a forward payload → recipient / `jetton_transfer` with the op from tonapi's `Call: 0x…` comment; `DepositStake` → pool / `stake`, `WithdrawStakeRequest` → pool / `unstake`, `WithdrawStake` → pool / `withdraw_stake`. tonapi does not spell out the pool-token burn of an unstake request, so for those events the source fetches `/v2/events/{id}` once and turns the account's `value_flow` jetton deltas into transfers (`raw.valueFlow`). `from` is the first action's initiator, `nativeValue` the TON it sent, `fee` = `-extra` (tonapi's "what the account lost beyond its actions", so it includes forward fees the actions do not show), `status` = `pending` while `in_progress`, `failed` when every action failed, `block` = the event's `lt`, `hash` = the event id (the trace root; tonapi resolves any transaction hash of the trace to it). `is_scam` events are flagged `scam: true` (also in `raw.scam`). Addresses stay raw (`0:…`, lowercase) as tonapi returns them.

**toncenter v3** (`GET /api/v3/transactions?account=&limit=&sort=desc&end_lt=`): the account's own transactions only. An external message (the wallet acted) maps its outgoing messages to TON transfers and the first op code to `call` (`data` = `opcode`, `method` = `decoded_opcode`); an incoming message maps its value and op. Jettons are not visible here, `fee` = `total_fees`, `hash` = the transaction hash in hex.

**Cursor.** Base64 JSON `{ v: 1, b: 'tonapi' | 'toncenter', lt }`: an exclusive `lt` upper bound (`before_lt` for tonapi, `end_lt = lt − 1` for toncenter). A cursor from one backend resumes on the other; the backend that issued it is tried first. `since` is applied client-side and ends pagination.

Fixtures in `test/fixtures/history/` were captured on 2026-10-14 from `tonapi.io` and `toncenter.com` (keyless) for the test wallet: one events page, the account-scoped events of the Tonstakers stake / unstake request / payout and of the Omniston STON.fi swap and escrow order (the same transactions as those modules' activity fixtures), the full event with `value_flow` for the unstake, and a toncenter v3 page. `test/history.test.ts` checks that the Tonstakers and Omniston modules describe the rows this source builds (`stake`, `unstake`, `claim`, `swap`, `bridge`). Note: `@forgewallet/protocol-swap2-core`'s `netTransfers` compares addresses verbatim, so `DescribeActivityContext.own` must contain the raw `0:…` form of the wallet for Omniston (Tonstakers normalizes itself).
