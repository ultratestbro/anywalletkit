---
"@anywalletkit/networks": patch
---

Three gaps in the networks table closed. `verifyNetwork` checks the genesis of `bitcoin:signet`, `bitcoin:regtest` and `zcash:regtest` (it passed any endpoint for them — the expected genesis was empty) and refuses a UTXO network it cannot identify instead of waving it through. `parseAddChainParams` drops private / local RPC hosts (localhost, 10.x, 192.168.x, *.local…) even over https unless `allowHttpLocal` is passed — a site must not point the wallet at the user's own network. And turning "Allow http for local nodes" off parks the `http://` local RPCs stored while it was on (skipped, with the reason) instead of still using them; turning it on again restores them.
