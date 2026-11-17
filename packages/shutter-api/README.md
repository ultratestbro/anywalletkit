# @anywalletkit/shutter-api

[![npm](https://img.shields.io/npm/v/@anywalletkit/shutter-api?label=npm)](https://www.npmjs.com/package/@anywalletkit/shutter-api)

Seal a message until a time, open it after, with [Shutter](https://shutter.network)'s threshold encryption. Nobody can read it before then: not you, not the app, not the API. A set of keypers releases the decryption key at the time you registered, and not before. This is commit-reveal for wallets and apps: sealed predictions, bids, votes, notes to the future.

- **Encryption and decryption run on the device**, in pure TypeScript (BLS12-381 IBE over `@noble/curves`). There is no WASM and no `Buffer`, so it runs in React Native (Hermes), browsers and Node. The output is byte-compatible with Shutter's own Go and TypeScript implementations: the tests run Shutter's published vectors.
- **Nothing is taken on trust that can be checked.** Each identity the API returns is re-derived from the prefix and the registering account. Each decryption key is checked against the eon key by pairing before it is used. Decryption verifies that the ciphertext was not changed (the Fujisaki–Okamoto check). The ciphertext never leaves the device: this package does not offer the API's `/decrypt_commitment`.
- **Two ways to register an identity:** through the Shutter API (no gas, the API's account registers), or **from the user's own account** on Gnosis Chain (`register(eon, prefix, revealAt)` on the registry the keypers watch), so the identity depends on no API account.

Beta (0.x). Apache-2.0.

## Install

```sh
npm install @anywalletkit/shutter-api
```

React Native needs a `crypto.getRandomValues` polyfill (`react-native-get-random-values`) for the encryption randomness.

## Seal and open

```ts
import { ShutterApi, seal, openText, ShutterNotYetRevealedError } from '@anywalletkit/shutter-api'

const api = new ShutterApi()  // Gnosis mainnet; SHUTTER_CHIADO for the testnet
const sealed = await seal({ api, message: 'ETH closes the year above $5k', revealAt: Math.floor(Date.parse('2027-01-01') / 1000) })
// sealed: plain JSON (identity, eon, eon key, reveal time, ciphertext, registration tx). Store it, share it, publish it.

try {
  console.log(await openText(sealed, api))
} catch (e) {
  if (e instanceof ShutterNotYetRevealedError) console.log('sealed until', new Date(e.revealAt! * 1000))
}
```

`open` refuses before `revealAt` without asking anyone. Right at the reveal time, the keypers take a few seconds to publish the key, and that also comes back as `ShutterNotYetRevealedError`. In the live runs, keys arrived 6–15 s after the reveal time.

### Register from the user's own account

```ts
const sealed = await seal({
  api, message, revealAt,
  registrant: { address: account.address, sendTransaction: (tx) => account.sendTransaction(tx) },  // { to, data, value: 0n, chainId: 100 }
})
await readRegistration((to, data) => rpc.call({ to, data }), api, sealed.identity)  // { eon, revealAt } once mined
```

The account sends `register(eon, identityPrefix, revealAt)` to the registry, so it needs a little xDAI for gas. The message is encrypted only after the wallet hands the transaction over. If the user refuses to sign, nothing is sealed that could never open.

## Lower level

```ts
import { encrypt, decrypt, verifyDecryptionKey, deriveIdentity, registerCalldata } from '@anywalletkit/shutter-api'

const ciphertext = encrypt({ message, identity, eonKey })          // 0x03 ‖ c1 ‖ c2 ‖ c3
verifyDecryptionKey(key, identity, eonKey)                           // e(key, G2) = e(H(identity), eonKey)
const plaintext = decrypt(ciphertext, key)                           // throws if the key or ciphertext is wrong
deriveIdentity(prefix, registrant)                                   // keccak256(prefix ‖ registrant)
```

`ShutterApi` has `registerIdentity`, `getEncryptionData` and `getDecryptionKey`. All three check every answer as described above. Errors are typed:

- `ShutterApiError`: carries the HTTP `status`; `rateLimited` is set on a 429.
- `ShutterNotYetRevealedError`: the key has not been released yet.
- `ShutterCryptoError`: something is wrong with the cryptographic input, the key or the ciphertext.

## Networks and limits

| | Gnosis (`SHUTTER_GNOSIS`) | Chiado (`SHUTTER_CHIADO`) |
|---|---|---|
| API | `https://shutter-api.shutter.network/api` | `https://shutter-api.chiado.staging.shutter.network/api` |
| Registry (watched by the keypers) | `0x0baaEa85A5aa87603772cCcDd41A07C7D712cee4` | `0x2693a4Fb363AdD4356e6b80Ac5A27fF05FeA6D9F` |
| API account | `0x228DefCF37Da29475F0EE2B9E4dfAeDc3b0746bc` | `0xd150bbf86C686de1a25820A94c2C2397e0bC54ab` |

The Gnosis registry address is the one the API registers into and the keypers serve, checked on chain on 2026-11-17. The API README lists a different one, which has no registrations. Without an API key, mainnet allows 5 registrations, 10 encryption-data requests and 20 decryption-key requests per IP per day. Chiado has no limits. Pass `apiKey` (Shutter issues them) to lift the limits; in a mobile app, call through your backend rather than shipping the key.

On Hermes (the CLI VM), encrypting takes about 350 ms, checking a decryption key about 320 ms and decrypting about 200 ms.

## What it relies on

The scheme is a threshold: the keypers (currently 3 of 5 on the production API) can release a key early only if a threshold of them collude. The eon key comes from the API. This package checks that it is a valid point, and that every decryption key matches it. It does not yet read the eon key from the keypers' on-chain broadcast contract.

## Live checks

`node scripts/verify-live.mjs gnosis|chiado [--self]` runs the full cycle and appends the result to `tests/fixtures/live-<network>.json`: seal, refuse an early open, confirm the registration on chain, open after the reveal time.
