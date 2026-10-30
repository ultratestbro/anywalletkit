---
"@anywalletkit/kit": patch
"@anywalletkit/wallet-evm": patch
---

A Permit2 grant is read only through the schema that gets signed (scan 2026-10-30, F4). The policies took `details` whenever the message had one, so a `PermitTransferFrom` that signs `permitted` (a large amount) could show an undeclared `details` decoy (a tiny amount of another token) to `confirm`. Now the grant field is the one Permit2 uses for the primary type (`details: PermitDetails` / `PermitDetails[]` for allowance permits, `permitted: TokenPermissions` / `TokenPermissions[]` for transfer permits), its struct must declare `token` and `amount` with Permit2's types, and `spender`, `sigDeadline` / `deadline` and `expiration` count only when declared. Any other schema is the worst case: `unlimited`, no token or amount, and an undeclared spender is an unknown destination. `describeTypedData` in wallet-evm reads Permit2 the same way and flags an unreadable schema `approve-unlimited`. Canonical Permit2 payloads (Uniswap, 1inch, witness and batch forms) read exactly as before.
