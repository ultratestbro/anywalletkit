---
"@anywalletkit/tx-preview-evm": minor
---

`expectedRecipient` is now compared with where the simulated output actually goes. Before, it was only checked for being one of `own`, so a swap whose output went to someone else still showed `recipient-own: ok` and no warning. With a successful simulation two new warnings can appear:

- `output-missing`: the sequence spends something and nothing arrives at `expectedRecipient` (`detail.address`).
- `output-foreign`: the output ends at an address that is not `expectedRecipient`, not one of `own`, and passes nothing on in the sequence (`detail.address`, `detail.token`, `detail.amount`). Pools and routers forward tokens and are never flagged; a third party's share of 5 % of the output or less is read as a fee.

The `ok` simulation also carries `transfers` (every token and native movement of the sequence, `{token, from, to, amount}`); the output checks need it, so a `Simulation` you build yourself for `checksFor` without it runs none.

What to do: add the two codes to your review wording (an exhaustive `switch` over `CheckCode` needs the new cases). Pass `expectedRecipient` only for a same-chain swap: a bridge's output arrives on another chain, so nothing arrives here and `output-missing` would fire. For a bridge, check the destination address yourself.
