---
"@anywalletkit/wallet-evm": patch
---

Sending on a chain without EIP-1559 works without fee fields. On a network whose blocks have no base fee, `quoteTransfer` / `quoteSendTransaction` already priced the transaction at `gasPrice`, but `transfer()` and `sendTransaction()` without fee fields threw, so a transfer that quoted fine could not be sent. Now, when the transaction sets no `type` and no EIP-1559 fee field, both the quote and the send use the network's `gasPrice` and sign a legacy transaction; the fee cap applies as before. An explicit `type: 2` / `type: 4` or `maxFeePerGas` / `maxPriorityFeePerGas` on such a chain still throws, and a network error while reading fees is no longer turned into a `gasPrice` quote. Nothing to change in apps.
