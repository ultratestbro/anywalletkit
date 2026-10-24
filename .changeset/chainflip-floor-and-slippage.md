---
"@anywalletkit/protocol-swap2-chainflip": patch
---

A caller who passes both `minAmountOut` and `slippageBps` is held to both: the minimum is the higher of the floor and the expected output less the slippage. Previously the floor replaced the slippage, so an execution re-quote (a floor 50 bps under the listed quote plus the list's slippage) came back wider than the slippage and the engine refused it as "rejected by validation". A floor alone, or a slippage alone, behaves as before.
