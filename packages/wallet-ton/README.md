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
  emulateUrl: 'https://toncenter.com/api/emulate/v1/emulateTrace',           // optional: full preflight
})
const account = await wallet.getAccount(0)

account.describe({ to: 'UQ…', value: 100_000_000n, body: 'thanks' })         // offline: kind, items, warnings
await account.simulateTransaction({ to: 'UQ…', value: 100_000_000n })         // fees (+ emulation verdict)
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
3. Preflight on the zero-signed body: toncenter `estimateFee` (the fee cap),
   and when `emulateUrl` is set a trace emulation — a non-zero compute exit,
   an aborted transaction or a failed action phase throws `SimulationError`
   **before signing**. `simulate: false` skips it.
4. noble ed25519 over the body hash; the 32-byte seed is the only key material
   and `dispose()` zeroizes it.
5. `sendBoc` of the external (with StateInit when the wallet is not deployed).

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
