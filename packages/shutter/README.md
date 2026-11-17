# @anywalletkit/shutter

[![npm](https://img.shields.io/npm/v/@anywalletkit/shutter?label=npm)](https://www.npmjs.com/package/@anywalletkit/shutter)

[Shutter](https://shutter.network)'s threshold encryption for wallets and apps, on the device, in two ways:

- **Sealed messages (Shutter API).** Seal a message until a time, open it after. Nobody can read it before then: not you, not the app, not the API. A set of keypers releases the decryption key at the time you registered, and not before. This is commit-reveal for wallets and apps: sealed predictions, bids, votes, notes to the future.
- **Encrypted transactions (encrypted mempool).** The wallet signs a transaction and encrypts it before it leaves the phone. Only the ciphertext goes on chain; the keypers release its key for the block it is scheduled in, and a Shutter validator decrypts it into that block. The order is fixed before anyone can read the transaction, so nobody can front-run or sandwich it. No RPC operator sees it in the clear.

- **Encryption and decryption run on the device**, in pure TypeScript (BLS12-381 IBE over `@noble/curves`). There is no WASM and no `Buffer`, so it runs in React Native (Hermes), browsers and Node. The output is byte-compatible with Shutter's own Go and TypeScript implementations: the tests run Shutter's published vectors.
- **Nothing is taken on trust that can be checked.** Each identity the API returns is re-derived from the prefix and the registering account. Each decryption key is checked against the eon key by pairing before it is used. Decryption verifies that the ciphertext was not changed (the Fujisaki–Okamoto check). The ciphertext never leaves the device: this package does not offer the API's `/decrypt_commitment`.
- **Two ways to register an identity:** through the Shutter API (no gas, the API's account registers), or **from the user's own account** on Gnosis Chain (`register(eon, prefix, revealAt)` on the registry the keypers watch), so the identity depends on no API account.

Beta (0.x). Apache-2.0.

## Install

```sh
npm install @anywalletkit/shutter
```

React Native needs a `crypto.getRandomValues` polyfill (`react-native-get-random-values`) for the encryption randomness.

## Seal and open

```ts
import { ShutterApi, seal, openText, ShutterNotYetRevealedError } from '@anywalletkit/shutter'

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

## Send an encrypted transaction

```ts
import { sendEncryptedTransaction, waitForEncryptedTransaction } from '@anywalletkit/shutter'

const sent = await sendEncryptedTransaction({
  rpc,        // EIP-1193 `request` on Gnosis: a viem client, a wallet RPC
  account,    // { address, signTransaction }: signs offline (wallet-evm's account fits)
  tx: { to, data, value },
})
const status = await waitForEncryptedTransaction(rpc, sent)  // 'included' | 'submission-failed' | 'replaced' | 'pending'
```

What happens:

1. The eon (keyper set) and its public key are read from the keypers' contracts on chain.
2. The account signs the transaction with nonce n + 1 (offline), and the package checks it signed exactly that.
3. The signed transaction is encrypted for `identityPrefix ‖ account` with a random prefix.
4. The account signs the submission with nonce n: `submitEncryptedTransaction(eon, prefix, ciphertext, gasLimit)` to the Sequencer, paying `gasLimit × maxFeePerGas` for the encrypted gas. Only this one is broadcast.
5. When a Shutter validator proposes, the keypers release the key for the queued identities. The validator decrypts the transaction and puts it in its block, under the transaction's own hash.

Refused before anything is signed: the wrong chain, a gas limit over the 1M gas set aside per block for encrypted transactions, a balance that cannot pay both transactions, an eon without a published key, a network past its shutdown date.

Until it is in a block, the account must send nothing else: any transaction with nonce n + 1 replaces it. That is also how to cancel, or to give up and send it publicly. Only blocks proposed by validators registered with Shutter decrypt, so the wait depends on how many are registered. On 2026-11-18 it was 37 of about 296,000 Gnosis validators, and Shutter's explorer estimated about 11 hours to inclusion. The default 10-minute wait then ends with `pending`: the ciphertext stays queued, keep following it with `getEncryptedSendStatus`. Our two live sends on 2026-11-17 (a transfer after 39 minutes, a 1inch swap through LI.FI after 94 seconds, both successful, the swap at exactly the quoted amount) were both recorded by Shutter's explorer as *unshielded* inclusions: the keypers released the key, but each transaction landed in the block after the decrypting slot, as an ordinary transaction. Decryption works; whether an inclusion is protected depends on the validators, which the wallet cannot control. The eon key comes from your RPC: use one you trust.

**Shutdown.** Shutter decommissions the Gnosis encrypted mempool on 2026-11-25, and `SHUTTER_GNOSIS_MEMPOOL` refuses from 2026-11-24. The next deployment target is Ethereum (EIP-8491). The network is a parameter (`ShutterMempoolNetwork`: Sequencer, keyper set manager, key broadcast contract, chain), so a new deployment needs a new preset, not new code, as long as it keeps this protocol.

## Lower level

```ts
import { encrypt, decrypt, verifyDecryptionKey, deriveIdentity, registerCalldata } from '@anywalletkit/shutter'

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

`node scripts/send-encrypted-live.mjs` sends a small encrypted xDAI transfer to yourself on Gnosis and follows it into a block (`tests/fixtures/live-mempool-gnosis.json`).
