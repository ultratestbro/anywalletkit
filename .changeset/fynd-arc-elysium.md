---
"@anywalletkit/protocol-swap2-fynd": minor
---

Fynd on Arc and Elysium. `FYND_CHAINS` pins the registry's active TychoRouterV3 on Arc (5042, `0x52A1…980f`, hosted API `/v1/arc`) and Elysium (99901, `0x643577…2662`, `/v1/elysium`); quotes, `fyndPins.callTargets` and `fyndPins.spenders` accept only those, and `describeFyndActivity` labels swaps through them. A swap with a chain's native coin on either side is now refused where the token catalog lists no native coin — on Arc, whose native USDC is accounted in 18 decimals while the catalog lists USDC through its 6-decimal ERC-20 (`fyndNativeSwaps(chainId)`); swap the ERC-20 instead. Plasma is not added: the registry lists a router there, but the hosted API does not serve the chain.
