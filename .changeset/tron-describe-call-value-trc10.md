---
"@anywalletkit/wallet-tron": patch
---

`describeTransaction` now flags what a contract call moves besides its calldata: new warnings `call-value` (the call also sends TRX to the contract, amount in TRX), `call-token-value` (it also sends a TRC-10 token) and `unknown-selector` (a selector the wallet does not decode). New description fields `callTokenValue` and `tokenId` carry the TRC-10 `call_token_value` / `token_id` decoded from `raw_data_hex`. Warnings stay informational and nothing new is refused.
