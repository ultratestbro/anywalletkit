---
"@anywalletkit/wallet-evm": minor
---

New default fee-rate ceiling for fee fields you pass yourself. When a transaction you sign or send sets `gasPrice`, `maxFeePerGas` or `maxPriorityFeePerGas`, the account now reads the network's current quote (the higher of `eth_gasPrice` and the EIP-1559 estimate) and refuses the transaction with `UnsafeTransactionError` before signing if the rate is more than 10× that quote and more than 10 gwei. This stops a mistyped or hostile fee (for example 10,000 gwei) from being signed, while a gas spike is fine because the quote is read at signing time, and fixed prices of a few gwei on cheap chains stay under the 10 gwei floor.

- Fees the account fills in itself are not checked and cost no extra RPC call.
- Without a provider, or when the quote cannot be read, nothing is refused; for offline signing keep using `transactionMaxFee` / `transferMaxFee`.
- Change the multiple with `maxFeeRateMultiplier` (e.g. `20`), or turn the check off with `maxFeeRateMultiplier: null` (or `Infinity`).
- `DEFAULT_MAX_FEE_RATE_MULTIPLIER` and `MIN_FEE_RATE_CEILING_WEI` are exported.
