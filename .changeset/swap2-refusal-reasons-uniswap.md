---
"@anywalletkit/protocol-swap2-uniswap": patch
---

Refusal reasons. Every refusal keeps its text; `getQuote` passes the classification to `onRefusal` as its second
argument, and the errors thrown by `preflightDeposit` and `buildDeposit` carry it (`refusalOf`). Flexible amounts,
cross-chain requests, a chain without a deployment or RPC, an uncatalogued or non-address token, native in or out where
the router wraps nothing, a wrap and the same token in and out `unsupported_pair`; a recipient that is not an EVM
address `recipient_mismatch`; a router or quoter that no longer match the pinned deployment `vault_mismatch`; no pool
route `no_route` (also a route that no longer quotes at preflight); every route running a pool dry (a partial fill, at
quote or preflight) `insufficient_liquidity`; a minimum that rounds to 0 `amount_too_small`; the caller's floor and a
preflight price under the minimum `price_check_failed`; a quote without a transaction `policy_refused`. When no RPC
answers, the refusal takes the last endpoint's status (429 `rate_limited` with Retry-After, 401 / 403 `key_rejected`,
5xx `upstream_unavailable` with `httpStatus`), else `upstream_unavailable` for a network failure, a timeout or an answer
that is not JSON; a quoter answer that does not decode at preflight is `upstream_unavailable` too (its error kept).
`uniswapPins` gains `reasonOf` for the texts `uniswapVerifyQuote` returns: an unpinned or cross-chain deployment, an
uncatalogued token and native on Celo `unsupported_pair`; another call target `vault_mismatch`; a swap or unwrap paying
another address `recipient_mismatch`; an input, minimum or price limit off the quote and an unwrap to the recipient of
another amount than the minimum `price_check_failed`; value or
approval off the input, another router call, extra legs, other tokens and paths `policy_refused`. A request that does
not parse, the `defaultSlippageBps` option check, an invalid amount and the caller's own abort stay unclassified.
