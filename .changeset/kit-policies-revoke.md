---
"@forgewallet/kit": minor
---

Revokes are `kind: 'revoke'` and are never stopped by the allowlist or the spender's blocklist entry: an `approve` / `signPermit` / EIP-2612 Permit of 0, raw revoke calldata (`approve(spender, 0)`, `approve(0x0, tokenId)`, `setApprovalForAll(…, false)`, Permit2 `lockdown`, or a batch of only these) and `revokeDelegation()`. Before, revoking a blocklisted drainer's allowance was refused, and with an allowlist only allowlisted spenders could be revoked. The blocklist still applies to the contract a revoke calls; the fee cap and `confirm` apply. `WriteIntent` gains `revokes`.
