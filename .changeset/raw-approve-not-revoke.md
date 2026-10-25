---
"@anywalletkit/kit": minor
"@anywalletkit/protocol-approvals-evm": patch
---

Raw `approve(spender, 0)` calldata is no longer a revoke to the policy engine. On an ERC-20 it zeroes an allowance, on an ERC-721 it approves `spender` for token #0, and the calldata cannot tell them apart: read as a revoke, it skipped the spender's blocklist entry and the allowlist, so a blocklisted drainer could be granted an NFT through `sendTransaction`. It is now `kind: 'approval'` with the spender as a destination. Any single raw `approve` / `setApprovalForAll(…, true)` call is an approval (amount and `unlimited` read off the calldata; the contract called is checked too), and in a batch their spenders join the destinations. Unambiguous revokes are unchanged: `approve({amount: 0})`, `approve(0x0, tokenId)`, `setApprovalForAll(operator, false)`, Permit2 `lockdown`, `revokeDelegation()`. `ApprovalsProtocolEvm.revokeAll` with `batch: true` now revokes ERC-20 through the account's `approve` when it has one, so a blocklisted spender can still be revoked. Audit 2026-10-25, #5.
