---
"@anywalletkit/protocol-lending-mellow-evm": minor
---

Deposits and redemptions go only to a queue the package or the caller pinned. For a preset, the shipped `MELLOW_ADDRESS_MAP[...].queues` list (re-checked against the chain on 2026-10-28: no queue added or gone) is now the authority, not only a hint for `describeActivity`: a queue the RPC's `queueAt` names outside it — the ERC-20 spender and the native deposit's recipient — is refused before any approval, as are `cancelSupply` / `claimShares` calls to it. Before, `queueAt` and the `hasQueue` re-check both came from the same RPC, so a user-added or tampered RPC took the whole deposit. **A custom `vault` now needs `queues: {deposit, redeem}`** with the expected queue addresses; for a preset the same option adds a queue Mellow introduced after a release.
