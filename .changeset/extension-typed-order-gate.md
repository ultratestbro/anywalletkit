---
"@anywalletkit/extension-kit": minor
"@anywalletkit/wallet-evm": minor
---

The swap gate checks the order itself and the account. A gasless swap's sheet said "Signed order" without the order, and its pre-approval let any EIP-712 data on the chain through once — another order or a Permit, for any account.

- `SwapApproval.source` for a typed order carries `typedData` (parsed) and `text` (pretty JSON) for the sheet.
- `GatedOp` `evm-typed-data` requires `typedDataHash` — `typedDataHash(typed)` from `@anywalletkit/wallet-evm` (now exported), the digest the account signs; `planMatchers` compares it (`typedDataMatcher`). A plan whose order cannot be hashed is refused before the sheet opens.
- `ReviewGate.preApprove(matchers, ttlMs, account)` binds pre-approvals to an account; a bound one passes only an op whose new `account` field names it. `SwapReviewMeta.account` and `EarnReviewMeta.account` are required and `reviewSwapPlan` / `reviewEarnPlan` always bind — pass the account in the ops your reviewed account builds.
- `@anywalletkit/wallet-evm` is now a dependency of extension-kit.
