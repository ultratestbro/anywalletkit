---
"@anywalletkit/protocol-swap2-0x": patch
---

Settler pins raised to the deployments 0x made on 2026-11-24 (0x-settler release 2026-11-24) on every chain: Ethereum 22/21, Optimism 22/21, BNB Smart Chain 24/23, Polygon 21/20, Base 23/22, Arbitrum 21/20, Avalanche 21/20 (`newestLiveNonce` / `previousLiveNonce`, read from the registry's `ownerOf(2)` / `prev(2)` on 2026-11-25 and checked by `verify:live`). Since 2026-11-24 the 0.1.5 table refused native-coin sales to the new Settlers on all seven chains (`vault_mismatch`, "newer than the newest one live when this module's chain table was pinned"); token sales used them inside the margin. No check changed.
