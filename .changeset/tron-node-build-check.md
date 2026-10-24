---
"@anywalletkit/wallet-tron": minor
---

Node-built transactions are checked against the request before they are simulated, priced or signed (scan F7). After `/wallet/createtransaction` and `/wallet/triggersmartcontract` the bytes must be exactly one contract of the requested type owned by this account — TransferContract: recipient and amount; TriggerSmartContract: contract address, calldata (`selector ‖ parameters`), call value and the `fee_limit` the wallet posted — with no Permission_id, no TRC-10 token on the call, no second contract and no field a build never carries; the memo the wallet splices in must be exactly the requested bytes in the requested encoding. A mismatch throws `UnsafeTransactionError('build-mismatch')`. This also applies to `quoteTransfer` / `quoteSendTransaction` / `estimateFee`, which build through the node. New export: `assertNodeBuild`.
