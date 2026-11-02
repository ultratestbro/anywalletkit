---
"@anywalletkit/wallet-near": minor
---

`signBuilt` now runs the same hard checks as `signTransaction` before it signs: the transaction must be this account's (signer and key), and a dangerous action — AddKey, DeleteKey, DeleteAccount, DeployContract, Stake, CreateAccount, global-contract actions, SignedDelegate — is refused with `UnsafeTransactionError` (`code: 'dangerous-action'`) unless the account was created with `allowDangerousActions: true`. Plain transfers and function calls sign as before, still with no node call. If your app signs prebuilt transactions that add or delete keys on purpose, set `allowDangerousActions: true` for that account.
