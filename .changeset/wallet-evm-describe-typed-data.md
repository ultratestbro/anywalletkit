---
"@anywalletkit/wallet-evm": patch
---

`describeTypedData` reads more of what dApps send: a hex domain `chainId` (it was dropped, and with it the chain-mismatch warning); Permit2 SignatureTransfer messages (`PermitTransferFrom` / `PermitBatchTransferFrom`, amounts under `permitted`) are flagged `approve-unlimited` at the max amount like AllowanceTransfer ones; a DAI-style permit (`holder`, `expiry`, `allowed`) is a `permit` — `allowed: true` an unlimited approval, `allowed: false` a revoke, `expiry` 0 no deadline — instead of `generic`.
