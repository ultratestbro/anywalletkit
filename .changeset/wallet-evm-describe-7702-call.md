---
"@anywalletkit/wallet-evm": patch
---

`describeTransaction` decodes the call inside an EIP-7702 (type 4) transaction. It returned only the delegation, so an `approve(spender, max)` riding in the calldata showed no spender, amount or `approve-unlimited` warning. The kind stays `eip7702-delegation`; the new `call` field says what the call is, and its token / spender / amount fields and warnings are filled as for any transaction.
