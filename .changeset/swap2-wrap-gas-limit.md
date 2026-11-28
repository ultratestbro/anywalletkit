---
"@anywalletkit/protocol-swap2-wrap": minor
---

Fix: a wrap or an unwrap on Flare, zkSync, Sei or MegaETH no longer runs out of gas. Every chain used to go out with `txRequest.gasLimit` 90,000; `eth_estimateGas` on 2026-11-28 found these four need more (a wrap into an empty balance: Flare 202,512, zkSync 186,454, Sei 97,833, MegaETH 98,470; unwraps on Flare and zkSync 175,850–192,037). Their limits are now Sei 150,000, MegaETH 200,000, Flare 350,000, zkSync 500,000 (`WRAP_GAS_LIMIT`, `wrapGasLimit(chainId)`, exported); every other chain keeps 90,000. The measurements are in `fixtures/gas/limits-2026-11-28.json`.
