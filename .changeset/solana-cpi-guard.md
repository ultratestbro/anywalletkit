---
"@anywalletkit/wallet-solana": minor
---

The simulation every send already runs now also guards against what a program the wallet signs for does by CPI, which the top-level checks cannot see. It returns the post-state of the wallet and of its token accounts the transaction writes, and the transaction is refused (`UnsafeTransactionError`) when the wallet's account would be handed to a program or given data (`wallet-owner`), a token account's owner or close authority changes (`sets-authority`), or a delegate allowance appears that no top-level Approve shows (`approves-delegate`). `allowAuthorityChanges` skips it. It costs one extra read per simulated send; a node that does not return the requested post-state is a `NetworkError`. Accounts behind lookup tables in a compiled transaction are resolved for it.
