---
"@anywalletkit/protocol-staking-spl-stake-pool-solana": patch
---

A delayed exit no longer gives up on pre-funded slot addresses. Anyone could send a little SOL to every predictable delayed-exit slot address (`createWithSeed(wallet, "<pool>-unstake:<i>", Stake)`), where `CreateAccountWithSeed` then fails; the module skipped such slots and refused delayed exits once 8 + 32 were poisoned. Now a pre-funded slot (System-owned, no data) is used: the exit prepends System `TransferWithSeed` (from the slot, base and destination the wallet, `fromOwner` = the Stake program the address was derived with) that moves exactly the SOL found there back to the wallet, then creates the stake account. Checked by a mainnet simulation of the instruction pair. Only a slot address held by another program is still skipped (bounded by `MAX_PREFUNDED_SLOTS`). New codec export `ixTransferWithSeed`.
