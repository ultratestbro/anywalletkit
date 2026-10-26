---
"@anywalletkit/wallet-tron": minor
---

The fee cap now holds for what a Tron transaction may really burn: its `fee_limit` of energy plus the bandwidth, memo and activation fees `fee_limit` does not cover must stay within the tighter of `transactionMaxFee` / `transferMaxFee` and `WriteOptions.maxFee` (`UnsafeTransactionError` `fee-limit` otherwise). The `fee_limit` the SDK derives for its own contract calls is capped by that cap, and `signRaw` takes `WriteOptions` and checks `fee_limit` against them. `signRaw` keeps signatures already on the transaction (a multisig co-signer's) and adds its own once, instead of replacing them.
