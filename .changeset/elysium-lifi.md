---
"@anywalletkit/protocol-swap2-lifi": minor
---

Elysium by Kinetiq (`eip155:99901`) is routed, as a source, a destination and for same-chain swaps. On Elysium the only trusted entry point is its own Diamond `0x24E6dA91AA4A8FEe2447F542c92E006243bd6Dc5` (li.quest `diamondAddress` = lifinance/contracts `deployments/elysium.json`; the canonical `0x1231…` has no code there), and `watch.json` reads its DiamondLoupe `facets()` like every other chain's. Checked live through this provider on 2026-11-10: Arbitrum / Base USDC → Elysium USDC.e, Elysium USDC.e → Base USDC and Elysium HYPE → Arbitrum USDC quote through LI.FI Intents, and HYPE ↔ USDC.e / USDC.e → kHYPE on Elysium through GenericSwapFacetV3. Native HYPE into Elysium is offered by LI.FI only through Relay, which the module refuses (the receiver is not bound in the calldata), so it has no route here.
