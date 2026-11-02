---
"@anywalletkit/tx-preview-evm": minor
---

`expectedRecipient` is now compared with where the simulated output actually goes. Before, it was only checked for being one of `own`, so a swap whose output went to someone else still showed `recipient-own: ok` and no warning. With a successful simulation two new warnings can appear:

- `output-missing`: the sequence spends something and nothing arrives at `expectedRecipient` (`detail.address`).
- `output-foreign`: more than 5 % of the output ends at addresses that are not `expectedRecipient` and not one of `own` (`detail.address`, `detail.token`, `detail.amount`), all of them together. A pool or router that passes the output on keeps none of it and is never flagged.

The `ok` simulation also carries `transfers` (every token and native movement of the sequence, `{token, from, to, amount}`); the output checks need it, so a `Simulation` you build yourself for `checksFor` without it runs none.

What to do: add the two codes to your review wording (an exhaustive `switch` over `CheckCode` needs the new cases). Pass `expectedRecipient` only for a same-chain swap: a bridge's output arrives on another chain, so nothing arrives here and `output-missing` would fire. For a bridge, check the destination address yourself.
