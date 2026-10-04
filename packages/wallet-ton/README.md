# @forgewallet/wallet-ton

TON accounts at `m/44'/607'/i'` (SLIP-10 ed25519) on `WalletContractV5R1`,
pinned by golden vectors in `@forgewallet/conformance`.

```ts
import WalletManagerTon from '@forgewallet/wallet-ton'

const wallet = new WalletManagerTon(seedPhrase, { tonClient: [{ url: 'https://toncenter.com/api/v2/jsonRPC', secretKey }] })
const account = await wallet.getAccount(0)
await account.transfer({ recipient: 'UQ…', amount: 100_000_000n })                    // 0.1 TON (nanotons)
await account.transfer({ token: USDT_MASTER, recipient: 'UQ…', amount: 1_000_000n })  // jetton
await account.sendTransaction({ to: 'EQ…', value: 50_000_000n, body: someCell })      // arbitrary internal message
const receipt = await account.getTransactionReceipt(hash)                            // hash = body hash, resolved via toncenter v3
wallet.dispose()
```

On import the package installs the `buffer` polyfill as `globalThis.Buffer` if
none exists (@ton/core requires the global). Node, and apps that already set it,
are untouched.

Signing goes through `WalletContractV5R1.createTransfer({ signer })` with noble
ed25519 over the message hash, so the 32-byte seed is the only key material and
`dispose()` zeroizes it. `Buffer` is imported from the `buffer` package — no global
polyfill is required by this package (React Native apps still install
`@forgewallet/runtime-hermes`).

## React Native

`@ton/crypto-primitives` resolves its `react-native` build on Metro, which
requires `expo-crypto` (random bytes) at module load and
`react-native-fast-pbkdf2` for mnemonic helpers the SDK never calls. Install
`expo-crypto` in the app (Expo projects already have it). Everything the wallet
signs goes through noble ed25519 and needs neither.
