# @anywalletkit/protocol-swap2-relay

## 0.1.2

### Patch Changes

- c1ca561: Refusal reasons. Every refusal keeps its text and code; it now also carries a `reason` (`Swap2RefusalReason`) on the thrown `RelayRefusal` (same class, name and `code`; the constructor takes the reason as an optional third argument), as `onRefusal`'s second argument, and through the new `relayPins.reasonOf` for the texts `verifyQuote` / `verifyBuild` return, so a remote stub's refusal is classified too. Relay's non-2xx answers are read as a 429 first (`rate_limited` with Retry-After, whatever the code), then by `errorCode` (`AMOUNT_TOO_LOW` → `amount_too_small`, `AMOUNT_TOO_HIGH` → `amount_too_large`, `NO_QUOTES` and the other no-route codes → `no_route`, `INSUFFICIENT_LIQUIDITY` → `insufficient_liquidity`, `CHAIN_DISABLED` / `ROUTE_TEMPORARILY_RESTRICTED` → `chain_halted`, the `UNSUPPORTED_*` / `INVALID_*_CURRENCY` codes → `unsupported_pair`, `INVALID_RECIPIENT` (a token contract that cannot receive) → `recipient_mismatch`, `SWAP_IMPACT_TOO_HIGH` → `price_check_failed`, `UNAUTHORIZED` / `UNAUTHORIZED_QUOTE` / `FORBIDDEN` → `key_rejected`, `SWAP_QUOTE_FAILED` and the transient `REQUEST_TIMED_OUT` / `RPC_HTTP_ERROR` / `PRICE_FETCH_FAILED` / `SERVICE_UNAVAILABLE` → `upstream_unavailable`; the last two reasons keep the HTTP status), then by the status (401 / 403 → `key_rejected`, 5xx → `upstream_unavailable`); another JSON refusal is `no_route`, a non-JSON one, a 200 that is not JSON, a network failure and the module's own timeout are `upstream_unavailable` (the caller's own abort is not, also when it cuts off the body being read). The device-side checks: unpinned or same chains, flexible amounts, uncatalogued or non-address tokens, answers that need another step, a second deposit or a second transaction, and non-`onchain` hubs → `unsupported_pair`; answers of another shape (no steps, no order, a malformed order, an unknown order version, no payment details) → `upstream_unavailable`; an order, deposit or refund paying, crediting or refunding another address or chain, or the zero address → `recipient_mismatch`; an unpinned solver, a bad signature, an order id that is not the order's or not the deposit's → `recipient_unverifiable`; a deposit, approval, chain or payment details off the pinned depository, or a deposit address → `vault_mismatch`; a minimum under the floor or slippage, an expected amount under the minimum, another output token, amounts the quote shows that are not the order's → `price_check_failed`; an order older than ten minutes → `quote_expired`; destination calls, order fees, app fees, gas top-ups, extra inputs or payments, an input chain, token or amount off the request, a refund in another token, unknown deposit calls, calldata or value off the order, a deadline further away than an order lives, a gas limit or quote life out of band, slippage past 50 %, a placeholder quote, a reused order and a quote that no longer says what was asked → `policy_refused`. A malformed request or configuration from the caller stays unclassified.
- Updated dependencies [fb6ca70]
  - @anywalletkit/protocol-swap2-core@0.12.0

## 0.1.1

### Patch Changes

- Updated dependencies [b1ac0e3]
  - @anywalletkit/protocol-swap2-core@0.11.0

## 0.1.0

### Minor Changes

- 31cf3f0: New package: Relay (relay.link) as a swap2 provider that talks to Relay directly and verifies the whole order on the device before anything is signed. EVM to EVM, exact input, native coin and ERC-20 through the RelayDepository on 29 pinned chains. The order's EIP-712 hash is recomputed and held to the id in the deposit calldata, the solver's signature must recover to the pinned signer, and recipient, chains, tokens, amounts, minimum, deadlines and every refund recipient are held to the request; the deposit and the exact approval are built locally for the pinned depository. Every refusal has a named reason.

### Patch Changes

- Updated dependencies [6d6e801]
- Updated dependencies [ff6582a]
  - @anywalletkit/swap2-assets@0.3.0
  - @anywalletkit/protocol-swap2-core@0.10.3
