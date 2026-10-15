---
"@forgewallet/kit": minor
---

Policies guard every write surface of an account, not only `sendTransaction` / `transfer`: `signTransaction` (fee cap, lists, confirm — a module that signs and broadcasts on its own cannot skip them), `sign` (message signatures: confirm only), and the chain-specific `sendSerialized` / `signCompiled` / `signTransactionMessage` where an account has them. `WriteIntent.method` is the new `WriteMethod` union and carries `message`.
