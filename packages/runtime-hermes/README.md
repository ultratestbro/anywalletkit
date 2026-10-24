# @anywalletkit/runtime-hermes

[![npm](https://img.shields.io/npm/v/@anywalletkit/runtime-hermes?label=npm)](https://www.npmjs.com/package/@anywalletkit/runtime-hermes)

One call, at the app entry, after `react-native-get-random-values`, `buffer` and a
TextEncoder polyfill are in place:

## Install

```sh
npm install @anywalletkit/runtime-hermes buffer fastestsmallesttextencoderdecoder react-native-url-polyfill
# or: pnpm add @anywalletkit/runtime-hermes buffer fastestsmallesttextencoderdecoder react-native-url-polyfill  ·  yarn add @anywalletkit/runtime-hermes buffer fastestsmallesttextencoderdecoder react-native-url-polyfill
```

On npm: [@anywalletkit/runtime-hermes](https://www.npmjs.com/package/@anywalletkit/runtime-hermes), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance. React Native / Hermes only; import it first in your entry file.

```ts
import 'react-native-get-random-values'
import { Buffer } from 'buffer'
global.Buffer ??= Buffer
import 'fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js'
import 'react-native-url-polyfill/auto'
import { installHermesRuntime } from '@anywalletkit/runtime-hermes'
installHermesRuntime()
```

What it installs, each only when missing:

| | why |
|---|---|
| `Buffer.prototype.subarray` keeps the Buffer prototype | Hermes has no `Symbol.species`; `@ton/core`, bitcoinjs-lib and other Node-style libraries call `.copy()` / `.readUInt32BE()` on sliced Buffers |
| `AbortSignal.timeout` / `AbortSignal.any` | missing on Hermes; their absence silently broke every cross-chain swap execution once |
| `crypto.subtle.digest` (SHA-256/384/512 via noble) | the Solana ed25519 polyfill creates `subtle` without `digest` |
| `structuredClone` | missing on older Hermes |

It throws when the things only the app can provide are absent: `crypto.getRandomValues`,
`TextEncoder`/`TextDecoder`, and a full WHATWG `URL` (React Native's built-in one has no
working `searchParams`; providers parse endpoints and query strings with it). SDK packages never import this package themselves.

## Metro: `react-native-fast-pbkdf2`

`@anywalletkit/wallet-ton` pulls in `@ton/crypto-primitives`, whose React Native build requires the
native `react-native-fast-pbkdf2` module (TON 24-word mnemonics) and `expo-crypto`. Install
`expo-crypto`, and point Metro at the pure-JS drop-in this package ships instead of the native module:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config')
const config = getDefaultConfig(__dirname)
const resolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) =>
  moduleName === 'react-native-fast-pbkdf2'
    ? { type: 'sourceFile', filePath: require.resolve('@anywalletkit/runtime-hermes/fast-pbkdf2') }
    : (resolveRequest ?? context.resolveRequest)(context, moduleName, platform)
module.exports = config
```

Same call shape as the native module (base64 in, base64 out), PBKDF2 from `@noble/hashes`.

