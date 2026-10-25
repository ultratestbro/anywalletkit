---
"@anywalletkit/protocol-staking-lido-evm": patch
"@anywalletkit/protocol-staking-ssv-evm": patch
"@anywalletkit/protocol-lending-mellow-evm": patch
"@anywalletkit/protocol-approvals-evm": patch
---

Lido, SSV, Mellow and Approvals read over a list of RPCs. They take the account's RPC from wallet-evm's config, where `provider` may be a list (the documented failover form); they handed that list to viem's `custom()`, which needs one EIP-1193 provider, so every read failed with `Cannot read properties of undefined (reading 'bind')`. A list now becomes a `fallback` transport, as in wallet-evm, Aave and Morpho, and each module's own `provider` option accepts a list too. Audit 2026-10-25, #1.4.
