---
"@anywalletkit/wallet-evm": minor
---

EIP-7702 (type 4) transactions are simulated and gas-estimated with their `authorizationList`, so the dry run executes the delegate's code instead of the account's own. A type 4 with `gasPrice` (or on a chain that answers with a legacy gas price) is refused instead of silently becoming a legacy transaction without its authorizations, and an `authorizationList` on a transaction that is not type 4 is refused instead of dropped (`assertTxShape`, exported).
