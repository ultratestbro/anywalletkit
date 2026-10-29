---
"@anywalletkit/wallet-solana": minor
---

The CPI guard watches token accounts the transaction creates. `sendTransaction` / `signTransaction` (the simulation that proves what a program the wallet signs for does by CPI) and `checkSerialized` used to read the post-state only of this wallet's token accounts that already existed, so a `CreateAssociatedTokenIdempotent` followed by a program that set a delegate, a close authority or (legacy SPL Token) a new owner on the fresh account by CPI was signed. Now every written account that does not exist yet, or is a bare System account, is asked for too; a token account of this wallet that the transaction creates counts as having had no delegate and no close authority, and this wallet's associated token account created for another owner is refused. `checkSerialized` asks the simulation only for accounts of the transaction (the node returns at most that many); an address outside it keeps its pre-state. `allowAuthorityChanges` still overrides the guard.

**Breaking:** a transaction that leaves a delegate allowance (with no top-level Approve), a close authority, or another owner on a token account of this wallet that it creates is refused with `UnsafeTransactionError` (`approves-delegate` / `sets-authority`) unless `allowAuthorityChanges` is set.
