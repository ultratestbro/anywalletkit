---
"@anywalletkit/kit": patch
"@anywalletkit/protocol-approvals-evm": patch
---

History no longer calls a raw `approve(spender, 0)` a revoke when it may be an NFT approval. On an ERC-20 it resets the allowance, on an ERC-721 it APPROVES `spender` for token #0; the policies already read it as an approval, while history wrote "Revoked …", so a user could believe an NFT approval was withdrawn when one was granted. The kit's generic description reads it as a `revoke` only on a known ERC-20 (a transfer marked `erc20`, or the swap2-assets catalog: USDT, USDC…), otherwise as an `approve` of the spender; `approve(0x0, id)` now reads as a `revoke` (it clears an NFT approval). `describeApprovalActivity` returns a `revoke` on a token `tokens` lists with `decimals` above 0 (or a transfer marks `erc20`), an `approve` on a known NFT, and null otherwise so the kit's catalog decides; pass `tokens` with `decimals` to keep the module's labels on ERC-20 revokes. Audit 2026-10-25 (post-release), M5.
