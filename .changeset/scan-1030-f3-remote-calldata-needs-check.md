---
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-router": minor
---

A remote stub's EVM calldata on a pinned contract needs the app's own check of the call (scan 2026-10-30, F3). A pinned contract executes whatever its arguments say — a CCTP burn's `mintRecipient`, an OFT send's `to`, a Diamond call's receiver — so the pin alone did not bind the call to the request. `remoteProvider` now marks a stub given `verifyQuote` with `verifiesQuotes` (as `verifyBuild` sets `verifiesBuilds`), the router keeps the marker in its snapshot, `remotePinRefusal` drops a remote EVM calldata quote from a stub with neither, and the engine refuses such a build before any approval.

**Breaking:** a remote stub with hand-made `callTargets` and no `verifyQuote` / `verifyBuild` gets no EVM calldata route. Every shipped EVM pins export carries a check (`lifiPins`, `cctpPins`, `usdt0Pins`, `wrapPins`, `uniswapPins`, `balancerPins`, `fyndPins`, `chainflipPins`, `thorchainPins()`); Omniston keeps its app-supplied `verifyBuild: omnistonVerifyBuild(...)`, which satisfies the rule. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
