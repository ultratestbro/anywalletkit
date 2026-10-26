---
"@anywalletkit/kit": patch
"@anywalletkit/wallet-btc": patch
"@anywalletkit/wallet-zcash": patch
"@anywalletkit/wallet-ton": patch
---

No signing path around the policies: the policy wrapper hides the account's `signer`, wraps accounts its methods return (NEAR's `withAccountId`) with the same policies, and `wallet.getManager(chain)` now hands out guarded accounts (`getAccount`, `getAccountByPath`, `getNamedAccount`) and hides the manager's seed and signer accessors. The internal helpers that sign in wallet-btc, wallet-zcash and wallet-ton are named `sign*` (`signSpend`, `signPlan`, `signMessages`), so the kit guards them like every other signing method.
