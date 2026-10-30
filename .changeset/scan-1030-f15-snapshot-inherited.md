---
"@anywalletkit/kit": patch
---

The policies' snapshot of a write reads what it inherits once, too (scan 2026-10-30, F15). The copy kept the caller's prototype, so a field the write inherited — `Object.create({ to })`, or an inherited getter — was still live: a prototype edited during `confirm`, or a getter answering differently on the signer's read, changed the signed transaction after it was judged. Now every inherited data value and accessor answer becomes an own value of the copy (methods stay on the prototype, so TON `Cell` / `Address`, `Buffer` and other class instances work as before), and a prototype that has no methods is not kept at all.
