---
"@anywalletkit/protocol-swap2-thorchain": patch
---

With a caller slippage the quote is asked with `liquidity_tolerance_bps` in a single request: LIM = expected output after THORChain's fees × (1 − slippage), the floor every other provider quotes. Previously the first request used `tolerance_bps` (measured from the feeless spot), which left only (slippage − fees) of room when fees fit and needed a retry when they did not. The 5% fee cap now reads the node's `fees.total_bps`. Quotes without a slippage keep `tolerance_bps` 300 and the adaptive widening.
