# @forgewallet/runtime-hermes

One call, at the app entry, after `react-native-get-random-values`, `buffer` and a
TextEncoder polyfill are in place:

```ts
import 'react-native-get-random-values'
import { Buffer } from 'buffer'
global.Buffer ??= Buffer
import 'fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js'
import { installHermesRuntime } from '@forgewallet/runtime-hermes'
installHermesRuntime()
```

What it installs, each only when missing:

| | why |
|---|---|
| `Buffer.prototype.subarray` keeps the Buffer prototype | Hermes has no `Symbol.species`; `@ton/core`, bitcoinjs-lib and other Node-style libraries call `.copy()` / `.readUInt32BE()` on sliced Buffers |
| `AbortSignal.timeout` / `AbortSignal.any` | missing on Hermes; their absence silently broke every cross-chain swap execution once |
| `crypto.subtle.digest` (SHA-256/384/512 via noble) | the Solana ed25519 polyfill creates `subtle` without `digest` |
| `structuredClone` | missing on older Hermes |

It throws when the two things only the app can provide are absent: `crypto.getRandomValues`
and `TextEncoder`/`TextDecoder`. SDK packages never import this package themselves.
