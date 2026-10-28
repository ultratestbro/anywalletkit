---
"@anywalletkit/protocol-swap2-lifi": minor
---

The Diamond calldata check reads every swap step, not only the first and last: each step must spend what the one before delivered, only steps spending the input token may pull from the wallet (`requiresDeposit`), together at most the input — a middle step depositing DAI under a leftover allowance was accepted. The GenericSwapFacet V3 entry points are bound to the asset kinds they move: `*ToNative` only for a native output, `*ToERC20` only for a token output, `NativeTo*` / `ERC20To*` only for the matching input — a `*ToNative` call counted a USDC minimum in wei. A bridge without source swaps must bridge the input, less at most a 1 % bridge fee (a `minAmount` of 1 passed and left the rest of the allowance standing). **`apiUrl` must be `https:`**; `allowInsecureApiUrl: true` allows plain http for local development.
