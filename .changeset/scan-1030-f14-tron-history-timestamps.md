---
"@anywalletkit/wallet-tron": patch
---

`createTronHistory().listActivity` no longer spins forever on a malformed TronGrid answer. Every row's `block_timestamp` is checked when its page arrives: it must be a non-negative safe integer (a transaction row without one still counts as 0, as before), and a `data` field that is not a list is refused; anything else fails the call with `HistoryUnavailableError(chain, '… malformed block_timestamp')`. The merge loop also fails the call if a pass consumes no row. Honest TronGrid pages read as before.
