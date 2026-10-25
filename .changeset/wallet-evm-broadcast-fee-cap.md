---
"@anywalletkit/wallet-evm": patch
---

Security fixes from the 2026-10-25 audit.

- **No second signature on failover.** A lost broadcast answer followed by `already known` from the next RPC now resolves to the hash of the transaction already sent, instead of signing a new one with the next nonce (a double payment). `nonce too low` is re-signed only after the account has checked that the rejected hash is not on the network; when that lookup fails the send ends as `BroadcastUnknownError`. `replacement transaction underpriced` is no longer retried.
- **The fee cap holds for what is signed.** `transferMaxFee` / `transactionMaxFee` were checked on a network quote while the caller's own `gasPrice` / `maxFeePerGas` was signed. They are now checked on the prepared transaction (gas limit × fee cap) before every signature, in `signTransaction` too, and the balance check uses the same worst-case fee. `quoteSendTransaction` prices the caller's fee fields, so the kit `maxFee` policy sees them. `TransferResult.fee` is that worst-case fee. A caller tip above the network's now lifts the fee cap with it (it used to produce a tip above the cap).
