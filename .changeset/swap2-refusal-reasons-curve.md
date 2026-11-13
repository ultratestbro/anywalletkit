---
"@anywalletkit/protocol-swap2-curve": patch
---

Refusal reasons. Every refusal keeps its text; `getQuote` passes the classification to `onRefusal` as its second
argument, and the errors thrown by `preflightDeposit`, `buildDeposit` and the JSON-RPC client carry it (`refusalOf`).
Flexible amounts, cross-chain requests, a chain without router, allowlist or RPC, an uncatalogued or non-address token,
the router's 0xEeee sentinel, the same token in and out and a wrap `unsupported_pair`; a recipient that is not an EVM
address `recipient_mismatch`; a zero amount and a minimum that rounds to 0 `amount_too_small`; no allowlisted route, or
none that quotes the amount, `no_route`; the caller's floor `price_check_failed`; a router off its pinned code or
version `vault_mismatch`; a quote without a transaction `policy_refused`. When no RPC answers, the refusal takes the last
endpoint's reason (HTTP 429 `rate_limited` with Retry-After, a JSON-RPC rate-limit error `rate_limited`, 401 / 403
`key_rejected`, any other status `upstream_unavailable` with `httpStatus`), else `upstream_unavailable` for a network
failure, a timeout, an answer that is not JSON or leaves calls unanswered. At preflight (and in `curveRemotePins`
`verifyBuild`): the price moved under the minimum, and a remote build's output or minimum off the fresh `get_dy`,
`price_check_failed`; `get_dy` reverting `simulation_failed`; another call target, approval, pool code or coin
`vault_mismatch`; an unreadable pool `upstream_unavailable`; other bytes, value or chain `policy_refused`.
`checkRoute`'s texts: a denied or unlisted pool, a wrap or ERC-4626 hop off the pinned contract `vault_mismatch`; a
route ending at another token `price_check_failed`; every other route shape `policy_refused`. `curvePins` and
`curveRemotePins` gain `reasonOf` for the texts `curveVerifyQuote` and `verifyBuild` return (also `unsupported_pair`,
`recipient_mismatch`, and `price_check_failed` for a minimum of 0 or off the quote), so a remote stub's "fails this
app's own check" error carries the reason. The `defaultSlippageBps` option check, an invalid amount or slippage, a chain
with no RPC endpoint configured and the caller's own abort stay unclassified.
