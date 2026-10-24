---
"@forgewallet/wallet-ton": minor
---

`network: 'testnet'` now uses the testnet wallet_id (network_global_id -3), as Tonkeeper and @ton/ton do. Mainnet addresses are unchanged.

- **What changes:** a testnet wallet gets its own address, and the externals it signs are no longer valid on mainnet.
- **What it fixed:** before, testnet reused the mainnet wallet_id (-239). Any testnet send could be replayed on a mainnet wallet with the same seqno.
- **Refused config:** a `walletId.networkGlobalId` that contradicts `network` is refused (`UnsafeTransactionError` with code `network-mismatch`).
