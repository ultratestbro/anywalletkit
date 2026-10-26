---
"@anywalletkit/keyring": patch
---

A key source removed while `addAccount`, `discoverAccounts` or `completeAddresses` was reading its secret no longer gets an account added back. The change used to run after the removal and saved an orphan account (which could become the active one); it now checks, inside the serialized change, that the source still exists and refuses with `not-found`.
