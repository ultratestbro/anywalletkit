---
"@anywalletkit/protocol-swap2-cow": patch
---

Every CoW refusal now carries core's machine-readable reason, not only text. Before, only HTTP 429 and 5xx had one.
- Orderbook error types map through the new `COW_ERROR_REASONS`: `NoLiquidity` → `no_route`, `InsufficientLiquidity` → `insufficient_liquidity`, `SellAmountDoesNotCoverFee` → `amount_too_small`, `UnsupportedToken` → `unsupported_pair`, `QuoteNotVerified` → `simulation_failed`, and so on.
- On a 4xx response the error type wins over the status. CoW's 403 `Forbidden` is about the wallet, so it is `policy_refused`, not `key_rejected`.
- Every check before a request names its reason too: another chain, an unknown or non-EVM token, wrapping or unwrapping → `unsupported_pair`; bad slippage → `price_check_failed`; a recipient that is not an EVM address → `recipient_mismatch`.
