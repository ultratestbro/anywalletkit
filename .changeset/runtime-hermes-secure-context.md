---
"@anywalletkit/runtime-hermes": minor
---

`installSecureContext()` (run by `installHermesRuntime`, reported as `secureContext`): sets `globalThis.isSecureContext = true` when the VM has no such flag. `@solana/kit` refuses `crypto.subtle` outside a secure context, so every program-derived address — associated token accounts, token metadata accounts — threw under Hermes. A browser's own value is kept.
