---
"@anywalletkit/protocol-swap2-fynd": patch
---

Tycho redeployed TychoRouterV3 on every chain on 2026-11-16 (registry commit 8aab890) after pausing the earlier routers, and Fynd's API now builds every transaction to the new ones, so 0.2.12 refused every quote ("the transaction targets 0xe41c…5126, not the Tycho router on Ethereum"). `FYND_CHAINS` now pins the redeployed router on Ethereum, Base, Arbitrum, BNB Smart Chain, Polygon, Unichain and Robinhood Chain; quotes, `fyndPins.callTargets` and `fyndPins.spenders` accept only those. The paused routers move to `FYND_PREVIOUS_ROUTERS`, read only by `describeFyndActivity` so past swaps keep their label in history.
