---
"@anywalletkit/wallet-evm": patch
---

`verifyTypedData` accepts the signatures `signTypedData` makes when the domain `chainId` is a string. Signing normalised `"0x89"` / `"137"` to the number 137 before hashing (so `chainId` is part of the domain, as a verifying contract computes it), while verifying hashed the domain as given — the account's own signature did not verify. Both now use one `typedDataHash()`. Audit 2026-10-25, #1.6.
