---
"@anywalletkit/protocol-lending-morpho-evm": patch
---

Unichain: Vault V2 vaults are recognised. The preset now pins Unichain's VaultV2Factory `0xC9b34c108014B44e5a189A830e7e04c56704a0c9`. It is listed on docs.morpho.org, and on-chain its bytecode is the same as the Base and Katana factories. Before this, every Unichain Vault V2 failed the factory check and was refused unless `allowUnverifiedVault` was passed.
