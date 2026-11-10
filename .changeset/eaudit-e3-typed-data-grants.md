---
"@anywalletkit/wallet-evm": minor
---

`describeTypedData` describes every asset-granting typed-data form as a grant. Permit2 (all primary types)
now returns `permit2` with the spender, every token / amount (with expiration and nonce for
AllowanceTransfer), the deadline and the witness type; Seaport `OrderComponents` / `BulkOrder` is a new
`seaport` kind with the offer and the consideration (each item's recipient); `SafeTx` returns `safeTx` with
to / value / data / operation and the decoded inner call. New warnings: `spender-unknown` on any permit or
Permit2 grant whose spender is not in the new `knownSpenders` option (address → label),
`consideration-foreign` when a Seaport order pays anyone but the signer (worded as "receive nothing back"
when nothing returns to the signer), and `safe-delegatecall` for operation 1 or an unreadable operation.
Callers that compared the warning list of a permit with `[]` now also see `spender-unknown` unless they
pass the spender in `knownSpenders`; code that switches on `kind` should handle `seaport`.
