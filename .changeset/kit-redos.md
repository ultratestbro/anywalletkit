---
"@forgewallet/kit": patch
---

Two backtracking regexes on dApp / provider input are gone:

- **EIP-712 primary-type inference:** the field type is cut at the first `[`, linear and identical to wallet-evm's signer.
- **base64 decoding of serialized Solana / NEAR transactions:** padding is stripped with a linear walk, and input above 8 MiB is not decoded.

Measured on the old code: 24 s and 111 s for one hostile request, during which the wallet was frozen before any prompt.
