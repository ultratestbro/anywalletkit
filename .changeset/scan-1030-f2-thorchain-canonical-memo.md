---
"@anywalletkit/protocol-swap2-thorchain": patch
---

`thorchainPins().verifyBuild` requires the build's memo to be the canonical memo byte for byte (scan 2026-10-30, F2). It rebuilt the canonical memo from the app's request but then dropped it, so a remote build whose memo named another output asset on the same chain (e.g. `ETH.USDC` instead of `ETH.ETH`) with the right recipient and limit was signed. The server's local provider already emits only canonical memos, so honest EVM router and Tron deposit corridors are unchanged.
