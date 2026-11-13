---
"@anywalletkit/protocol-swap2-thorchain": patch
---

Refusal reasons. Every refusal keeps its text; `getQuote` passes the classification to `onRefusal` as its second
argument, and `buildDeposit` / `preflightDeposit` errors carry it (`refusalOf`). The node's own quote rejection is
read from its text: an output under the price limit `price_check_failed` (an output of 0 `amount_too_small`), a halt
`chain_halted`, a missing pool `unsupported_pair`, dust or fees `amount_too_small`, too little liquidity
`insufficient_liquidity`, throttling `rate_limited`, the API key `key_rejected`; else its status (401 `key_rejected`),
a 4xx without a JSON body `upstream_unavailable` with `httpStatus`, anything else `no_route`. When every node fails,
the refusal takes what they agree on: 429 `rate_limited` with the shortest Retry-After, 403 `key_rejected`, 5xx,
timeouts, network errors and other shapes `upstream_unavailable`. The module's own checks: no pool in the catalog, a
source without an executor and the deposit-address flow without the Tron opt-in `unsupported_pair`; the 8-decimal
precision, a slippage over the cap, THORChain fees over this module's 5% cap (they include the liquidity fee, so a
large swap through a thin pool trips it too: sending more would not help), a router on a deposit source, missing quote
metadata, a changed send or call `policy_refused`; dust, the recommended minimum and an output rounding to zero
`amount_too_small`; an incomplete quote or one without a router `upstream_unavailable`; the floor, the memo limit and
the slippage floor `price_check_failed`; a memo paying another address `recipient_mismatch`, a memo with an aggregator
tail `recipient_unverifiable`, a streaming limit `price_check_failed`, another affiliate or shape `policy_refused`; a
halted chain on the quoting or confirming node `chain_halted`; a rotated vault or router, an untrusted router, another
vault or router on the second node, calldata paying another vault and an approval for another spender
`vault_mismatch`; a confirming node too far behind `stale_node`; the confirmation budget running out
`upstream_unavailable`; no second node answering (and, in the pins, two nodes not confirming) what the confirming
nodes' failures agree on — every one throttled `rate_limited` with the shortest Retry-After — else
`upstream_unavailable`, a node the budget left unasked counting as unavailable; a quote expiring too soon or before
broadcast `quote_expired`. `thorchainPins()` gains `reasonOf`, which classifies each text its `verifyBuild` returns
the same way, so a remote stub's "fails this app's own check" error carries the reason. Configuration errors, a
malformed source hash and the caller's own abort stay unclassified, also when it lands while a quote's body is still
being read (only a status that classifies on its own, such as 401, is kept).
