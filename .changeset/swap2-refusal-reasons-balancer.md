---
"@anywalletkit/protocol-swap2-balancer": patch
---

Refusal reasons. Every refusal keeps its text; `getQuote` passes the classification to `onRefusal` as its second
argument, and the errors thrown by `preflightDeposit` and `buildDeposit` carry it (`refusalOf`). Flexible amounts,
cross-chain requests, a chain without a Vault or RPC, an uncatalogued or non-address token, a wrap, the same token in
and out and a native route through the wrapped native `unsupported_pair`; a recipient that is not an EVM address
`recipient_mismatch`; a Vault that does not wrap the pinned WETH `vault_mismatch`. The SOR: 429 `rate_limited` with
Retry-After, 401 / 403 `key_rejected`, 408 / 425 / 5xx `upstream_unavailable` with `httpStatus`, a network failure or
timeout, an answer that is not JSON, a GraphQL error and a malformed pool id `upstream_unavailable`; no v2 path
`no_route`; a split off the amount `price_check_failed`; a path that does not start and end at the requested tokens and
a route over 16 hops `policy_refused`. The Vault: a revert of the priced batch (`queryBatchSwap`: JSON-RPC code 3,
Nethermind's -32015 or a "revert" message) `simulation_failed`, any other node error on that call ("header not found",
"missing trie node", a limit, an internal error) `upstream_unavailable`, another input `price_check_failed`, zero output `amount_too_small`, an intermediate balance `policy_refused`, the
caller's floor and a preflight price under the minimum `price_check_failed`; a preflight transaction that is not the
quoted batch, not a `batchSwap`, over 16 hops or with pool `userData`, and a quote without a transaction
`policy_refused`. When no RPC answers, the refusal takes the last endpoint's status (429 `rate_limited`, 401 / 403
`key_rejected`, 5xx `upstream_unavailable`), else `upstream_unavailable`. `balancerPins` gains `reasonOf` for the texts
`balancerVerifyQuote` returns: an unserved chain or token `unsupported_pair`, another call target `vault_mismatch`,
funds paid to another address `recipient_mismatch`, limits or hops off the input and minimum `price_check_failed`, a
passed deadline `quote_expired`, funds taken from another account (the recipient right) and any other Vault call or
batch shape `policy_refused`. A request
that does not parse, an invalid amount, another SOR 4xx (a misconfigured URL) and the caller's own abort stay
unclassified.
