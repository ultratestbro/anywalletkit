---
title: Installation
description: Add Any Wallet Kit to a React Native (Expo) app or a Node service.
sidebar:
  order: 2
---


## Try it from source

The source is on [GitHub](https://github.com/ultratestbro/anywalletkit). Node 20+ and pnpm 10:

```sh
git clone https://github.com/ultratestbro/anywalletkit.git
cd anywalletkit
pnpm install
pnpm build
pnpm --filter ./examples/quickstart test
```

Every snippet on this site comes from a package in [`examples/`](https://github.com/ultratestbro/anywalletkit/tree/main/examples),
and each one runs the same way.

## Pick your packages

Every package is on npm under [`@anywalletkit`](https://www.npmjs.com/org/anywalletkit), published from
CI with provenance (`npm audit signatures` checks it). npm, pnpm, yarn and `npx expo install` all work;
the commands on this site use npm.

Every wallet needs `core` and `kit`, plus one package per chain family it supports:

```sh
npm install @anywalletkit/core @anywalletkit/kit \
  @anywalletkit/wallet-evm @anywalletkit/wallet-solana @anywalletkit/wallet-ton \
  @anywalletkit/wallet-btc @anywalletkit/wallet-tron @anywalletkit/wallet-near
```

Swaps, staking and lending are separate packages — add them when you need them
(see [Packages](/getting-started/packages/)).

## React Native / Expo

React Native is the primary target: every chain package is tested inside the Hermes VM
before a release. Hermes misses a few web APIs the cryptography and network code expect;
you install them once, at the app entry, **before anything else is imported**.

```sh
npx expo install react-native-get-random-values
npm install @anywalletkit/runtime-hermes buffer fastestsmallesttextencoderdecoder react-native-url-polyfill
```

Put the polyfills in their own file so nothing can be evaluated before them:

```js title="polyfills.js"
// 1. Secure randomness — seed phrases and signatures depend on it. Must be first.
import 'react-native-get-random-values'

// 2. A global Buffer (TON and Bitcoin libraries read it).
import { Buffer } from 'buffer'
globalThis.Buffer ??= Buffer

// 3. Hermes ships TextEncoder but no TextDecoder.
import 'fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js'

// 4. React Native's URL has no working searchParams; providers parse endpoints with it.
import 'react-native-url-polyfill/auto'

// 5. Everything else the SDK relies on: AbortSignal.timeout / any,
//    crypto.subtle.digest, structuredClone, the Buffer.subarray fix.
//    Each piece is installed only when it is missing; it throws if 1–4 are absent.
import { installHermesRuntime } from '@anywalletkit/runtime-hermes'
installHermesRuntime()
```

```js title="index.js"
import './polyfills'
import 'expo-router/entry' // or your AppRegistry.registerComponent(...)
```

Point `"main"` in `package.json` at `index.js`.

### TON on Metro

`@anywalletkit/wallet-ton` depends on `@ton/crypto-primitives`, whose React Native build requires
`expo-crypto` and the native `react-native-fast-pbkdf2` module. Install `expo-crypto`
(`npx expo install expo-crypto`) and resolve the native module to the pure-JS drop-in that
`runtime-hermes` ships:

```js title="metro.config.js"
const { getDefaultConfig } = require('expo/metro-config')
const config = getDefaultConfig(__dirname)
const resolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) =>
  moduleName === 'react-native-fast-pbkdf2'
    ? { type: 'sourceFile', filePath: require.resolve('@anywalletkit/runtime-hermes/fast-pbkdf2') }
    : (resolveRequest ?? context.resolveRequest)(context, moduleName, platform)
module.exports = config
```

:::tip
`installHermesRuntime()` returns a report of what it found (`native`, `patched`,
`polyfilled` or `missing` per API). Log it once in development builds when something
behaves differently on the device than in tests.
:::

:::note
Test on a **Release** build. Debug builds run JavaScript differently and can hide
problems that only show up in production.
:::

## Node

Node 20 or newer needs no polyfills:

```sh
npm install @anywalletkit/core @anywalletkit/kit @anywalletkit/wallet-evm
```

All packages ship ESM and CommonJS builds with TypeScript types.

## Next

Build your first multichain wallet in the [Quickstart](/getting-started/quickstart/).
