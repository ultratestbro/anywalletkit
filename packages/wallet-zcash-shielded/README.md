# @anywalletkit/wallet-zcash-shielded (prototype)

> **Prototype for SDK-229. Not published, not for production.** The API will change.

Shielded Zcash (Ironwood, NU6.3) for React Native wallets on Any Wallet Kit. A thin TypeScript layer
over [react-native-zcash](https://github.com/EdgeApp/react-native-zcash) (MIT), which wraps the ZODL
Zcash SDKs for iOS and Android, which in turn run librustzcash. This package does no Zcash
cryptography of its own beyond reading unified addresses (ZIP-316) to check what the SDK returns.

```
React Native app
  └─ @anywalletkit/wallet-zcash-shielded   TypeScript: config checks, bigint balances, address checks
       └─ react-native-zcash               RN native module (Swift / Kotlin)
            └─ ZODL Zcash SDK              zodl-swift-wallet-sdk / zodl-android-wallet-sdk
                 └─ librustzcash           Rust: ZIP-32 keys, note scanning, proofs, wallet database
```

## What works

| | |
|---|---|
| `ZcashShieldedWallet.open(phrase, config)` | Creates or reopens the wallet `alias` and starts syncing from `birthdayHeight` |
| `getAddress()` | Unified address, decoded and checked here: it has a shielded receiver, and its transparent receiver equals the account's t-address |
| `getBalance()` | Per pool (transparent, Sapling, Orchard, Ironwood): spendable, total, pending, all `bigint` zatoshi |
| `onSyncProgress()`, `onBalance()`, `onError()` | Status (`syncing` / `synced` / …), percent, chain tip |
| `decodeUnifiedAddress()`, `transparentReceiverAddress()` | ZIP-316 reader, tested against zcash-test-vectors |

`send`, `shield`, `migrateOrchard` and `describeTransaction` have signatures and throw
`NotImplementedError`.

## Keys

react-native-zcash takes the BIP-39 phrase when the synchronizer opens: the ZODL SDK derives the
unified spending key (ZIP-32, account 0) to create the account and keeps the viewing key in its
database. This package passes the phrase through once and does not keep it. Read it from
`@anywalletkit/secure-storage-react-native` right before `open` and drop it afterwards.

The transparent receiver is the BIP-44 key at `m/44'/133'/0'/0/0` — the same address
`@anywalletkit/wallet-zcash` account 0 gives for the same seed (tested on the ZIP-316 vector for
account 0, diversifier 0).

## Use

```ts
import * as RNZcash from 'react-native-zcash'
import { ZcashShieldedWallet, type NativeZcash } from '@anywalletkit/wallet-zcash-shielded'

const wallet = await ZcashShieldedWallet.open(phrase, {
  native: RNZcash as unknown as NativeZcash,
  server: { host: 'zec.rocks', port: 443 },
  birthdayHeight: 3_520_000,
  alias: 'main',
})
const { unified, receivers } = await wallet.getAddress()
wallet.onSyncProgress((p) => console.log(p.status, p.percent))
const balance = await wallet.getBalance()   // balance.ironwood.spendable …
```

Needs a react-native-zcash build with NU7 support (as of 2026-11-17 only the `jon/zcash-nu7-sdks`
branch, built from source with `npm run update-sources`).

License: Apache-2.0.
