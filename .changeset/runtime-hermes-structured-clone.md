---
"@anywalletkit/runtime-hermes": patch
---

The `structuredClone` polyfill is a real recursive clone. It was a JSON round trip with a bigint marker: `-5n` came back as the string `"-5n"`, the string `"100n"` as the bigint `100n`, and `Uint8Array`, `Date`, `Map`, `Set` as plain objects or strings. It now clones primitives (bigint included), Date, RegExp, ArrayBuffer, typed arrays, DataView, Map, Set, Error, arrays and plain objects, keeps shared references and cycles, and throws `DataCloneError` on functions and symbols, as the native one does.
