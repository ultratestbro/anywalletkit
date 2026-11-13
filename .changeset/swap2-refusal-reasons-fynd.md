---
"@anywalletkit/protocol-swap2-fynd": patch
---

Refusal reasons. Every refusal keeps its text; `getQuote` passes the classification to `onRefusal` as its second
argument, and the errors thrown by `preflightDeposit`, `buildDeposit` and `checkFyndTransaction` carry it
(`refusalOf`; `FyndTransactionError` keeps its class, name and text). The hosted API: 401 / 403 `key_rejected`, 429
`rate_limited` with Retry-After, 422 `no_route`, 408 / 425 / 5xx `upstream_unavailable` with `httpStatus`, a network
failure or the module's own timeout and a malformed answer (bad JSON, another order count, amounts that do not parse)
`upstream_unavailable`; the solver's status `no_route_found` `no_route`, `insufficient_liquidity`
`insufficient_liquidity`, `timeout` `upstream_unavailable`, `not_ready` `stale_node`, `price_check_failed`
`price_check_failed`, `encoding_failed` `amount_too_small`. The module's own checks: flexible amounts, cross-chain
requests, an unconfigured chain, an uncatalogued or non-address token and the same token in and out
`unsupported_pair`; a recipient that is not an EVM address, the zero or router receiver and calldata paying another
address `recipient_mismatch`; a transaction to another contract than the pinned Tycho router `vault_mismatch`; a 0 bps
slippage, an echoed input, a fee breakdown, calldata amounts or native value off the quote and the caller's floor
`price_check_failed`; a client fee, an excluded protocol, calldata of another shape or tokens, a preflight transaction
that is not the quoted swap and a quote without a transaction `policy_refused`; a native route that reverts at quote
time and a preflight revert (balance, approval, any other reason) `simulation_failed`, but the router's
`TychoRouter__NegativeSlippage` `price_check_failed`. `fyndPins` gains `reasonOf`, which classifies each text
`fyndVerifyQuote` returns the same way, so a remote stub's "fails this app's own check" error carries the reason. An
invalid amount from the caller, another 4xx (a misconfigured URL), an unknown solver status and the caller's own abort
(also while the answer is still being read) stay unclassified.
