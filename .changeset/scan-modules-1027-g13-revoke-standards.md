---
"@anywalletkit/protocol-approvals-evm": minor
---

Revokes are classified by the token's standard. `revoke()` and `revokeAll()` ask an `'erc20'` approval's token for ERC-165 (`supportsInterface(0x80ac58cd)`) before sending `approve(spender, 0)`, and refuse (`invalid-approval`) when it is an ERC-721 — there that call approves the spender for token #0; a token without ERC-165 is revoked as before, and a failed read sends nothing (`source-failed`). `isRevokeTransaction(tx, { targets })` takes the scan's approvals, a map from address to standard, or bare addresses (`RevokeTargets`): `approve(spender, 0)` is a revoke only on an ERC-20 target, `approve(0x0, id)` and `setApprovalForAll(operator, false)` on an NFT or bare-address target, and **without `targets` only a Permit2 `lockdown` is a revoke** (an `approve(x, 0)` without targets used to pass).
