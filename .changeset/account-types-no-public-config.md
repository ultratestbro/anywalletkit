---
"@anywalletkit/protocol-staking-lido-evm": patch
"@anywalletkit/protocol-staking-ssv-evm": patch
"@anywalletkit/protocol-lending-mellow-evm": patch
"@anywalletkit/protocol-approvals-evm": patch
---

The account types these modules take no longer declare a public `_config`. A `wallet-evm` account keeps its RPC in a protected `_config`, so `new LidoProtocolEvm(account)` (and SSV, Mellow, Approvals) with a real `WalletAccountEvm` or `WalletAccountReadOnlyEvm` failed to type-check — only the loosely typed `wallet.registerProtocol` path compiled. The modules still pick up the account's RPC when `config.provider` is absent.
