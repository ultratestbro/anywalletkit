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
