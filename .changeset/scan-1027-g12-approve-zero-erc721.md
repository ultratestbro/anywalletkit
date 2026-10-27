---
"@anywalletkit/wallet-evm": minor
"@anywalletkit/kit": patch
---

`approve({ amount: 0 })` is a revoke only on an ERC-20. wallet-evm's `approve` refuses a token that reports ERC-721 through ERC-165 (`0x80ac58cd`) or has no `decimals()` (`UnsafeTransactionError`), since on an NFT approve(spender, n) approves token #n. The kit classifies `approve({ amount: 0 })` as `kind: 'revoke'` only when the token is in the swap2-assets catalog or the account's `getTokenInfo` reads it as `erc20`; otherwise it is an approval of the spender and the allowlist and blocklist apply.
