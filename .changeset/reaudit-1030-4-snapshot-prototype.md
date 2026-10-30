---
"@anywalletkit/kit": patch
---

The policies' snapshot reads a class prototype as it was at snapshot time (re-audit 2026-10-30, #4). A prototype with methods was kept live, so a field added to it during `confirm` (a `data` the policy never saw) or a replaced method reached the signer. The copy still has the prototype, so `instanceof` and methods work (TON `Cell` / `Address` checked), but it answers only with its own keys and the methods captured at snapshot time, and writes from a method land on the copy.
