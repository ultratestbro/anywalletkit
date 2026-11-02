---
"@anywalletkit/kit": patch
"@anywalletkit/wallet-evm": patch
"@anywalletkit/wallet-btc": patch
"@anywalletkit/wallet-zcash": patch
---

A transaction is now one plain object everywhere it is signed. `wallet-evm` (`sendTransaction`, `signTransaction`, quotes and simulation), `wallet-btc` and `wallet-zcash` throw `UnsafeTransactionError` (BTC/Zcash: `code: 'malformed-spend'`) for a list or a class instance instead of reading its fields. In the kit's policies, a list that also carries named fields (`Object.assign([call], { to, value })`) has no known destination on any EVM chain (`destinationUnknown: true`, never a revoke or approval), and on Bitcoin, Zcash and other one-recipient chains any list does: an allowlist refuses it, a blocklist refuses it without a `confirm` hook. Plain lists of EVM calls for batching accounts and TON message lists are read as before. Nothing to change in apps that pass `{ to, value, data }` objects; an EVM list sent to a plain wallet-evm account (for example the approvals module with `batch: true`) now throws instead of being signed as a transaction other than the listed calls.
