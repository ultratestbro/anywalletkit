---
"@anywalletkit/protocol-swap2-router": patch
---

`RouterSwap2Protocol` keeps a frozen copy of its config, as the engine does. `using(provider)` — the protocol for the
route the user picked — is built from that copy, so it executes with the `nativeFeeCeiling`, `reviewExecution` and
other engine options the router was created with, even if the app changes its config object afterwards; a later
change to `prefer` no longer reaches the router either. No API change.
