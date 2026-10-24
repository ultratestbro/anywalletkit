---
"@anywalletkit/runtime-hermes": minor
---

`@anywalletkit/runtime-hermes/fast-pbkdf2`: a pure-JS drop-in for the native `react-native-fast-pbkdf2` module that `@ton/crypto-primitives` (under `wallet-ton`) requires on Metro. Resolve the module to it in `metro.config.js` and the bundle builds without a native dependency, and TON 24-word mnemonic imports work on the device instead of failing on a throwing stub.
