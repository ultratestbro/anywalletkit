---
"@anywalletkit/extension-kit": patch
---

Per-site EVM grants in `RequestRouter`. An origin sees the accounts it was granted that the wallet exposes right now (`accounts()`, the active account), as before; what changes is that connecting another account (`eth_requestAccounts` / `wallet_requestPermissions` after a switch) now ADDS it to that origin's grant through the new `PermissionStore.grant` instead of replacing the list, so switching back to an account the site already had needs no new sheet. `wallet_getPermissions` lists only the visible accounts. A signing request is refused with 4100 and a message that says to switch accounts when it names a granted account that is not the active one (or when the wallet is locked), and the `sign` hook now receives the visible accounts instead of the whole grant. `PermissionStore.setAccountsEverywhere` is deprecated: it rewrote every origin's grant to the active account and showed that account to sites it was never connected to; nothing in the package calls it, call sites should stop calling it.

`eth_getLogs` from an origin without an EVM grant may span at most `GETLOGS_MAX_SPAN_UNCONNECTED` (1000) blocks; a wider range (block tags resolved against `eth_blockNumber`) is refused with -32005 before it reaches the RPC. Connected origins and `blockHash` filters are unchanged.
