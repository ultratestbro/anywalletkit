---
"@anywalletkit/protocol-lending-morpho-evm": patch
---

Unichain: Vault V2 vaults are recognised. The preset now pins Unichain's VaultV2Factory `0xC9b34c108014B44e5a189A830e7e04c56704a0c9`. It is listed on docs.morpho.org, and on-chain its bytecode is the same as the Base and Katana factories. Before this, every Unichain Vault V2 failed the factory check and was refused unless `allowUnverifiedVault` was passed.

`MorphoApi.listVaults` now lists Vault V2 vaults. It used to query `vaultV2s(where: VaultV2Filters)`, but the API's filter type is `VaultV2sFilters`. The API rejected the query ('Unknown type "VaultV2Filters"'), and a catch-all dropped the error, so only Vault V1s were ever returned. A failed V2 query now throws instead of silently shortening the list. On 2026-11-04 the fixed query finds 121 listed V2 vaults on Ethereum and 33 on Base. A listed vault is not necessarily depositable: one that fails the dead-deposit rule stays listed (the API has no such field), and `quoteSupply` / `supply` refuse it with `MorphoDeadDepositError` before any approval.
