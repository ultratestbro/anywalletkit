---
"@anywalletkit/protocol-swap2-0x": patch
---

Settler pins raised to the deployments 0x made on 2026-11-24 (0x-settler release 2026-11-24) on every chain: Ethereum 22/21, Optimism 22/21, BNB Smart Chain 24/23, Polygon 21/20, Base 23/22, Arbitrum 21/20, Avalanche 21/20 (`newestLiveNonce` / `previousLiveNonce`, read from the registry's `ownerOf(2)` / `prev(2)` on 2026-11-25 and checked by `verify:live`). Since 2026-11-24 the 0.1.5 table refuses native-coin sales to the new Settlers on all seven chains (`vault_mismatch`, "newer than the newest one live when this module's chain table was pinned"); token sales use them inside the margin. On 2026-11-26 0x still quoted the previous Settlers, which 0.1.5 accepts: this patch is ready for the moment 0x moves its quotes to the new ones. In remote mode the app checks quotes against its own table, so ship 0.1.6 in the app as well as on the backend. No check changed.
