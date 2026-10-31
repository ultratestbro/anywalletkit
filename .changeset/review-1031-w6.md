---
"@anywalletkit/runtime-hermes": patch
"@anywalletkit/protocol-swap2-core": patch
---

Copies no longer turn an own `"__proto__"` key into a prototype. The Hermes `structuredClone` polyfill (installed only when the runtime has no native one) and the swap2 review copy assigned keys one by one, so an object parsed from JSON with a `"__proto__"` key came out with that object as its prototype and inherited fields from it. The key is now kept as an own property, as the native `structuredClone` does; cycles and shared references are kept as before. Nothing to change in your app.
