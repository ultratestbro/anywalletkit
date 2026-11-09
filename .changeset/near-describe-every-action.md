---
"@anywalletkit/wallet-near": patch
---

`describeTransaction` describes every action of a multi-action transaction instead of letting each `ft_transfer` overwrite the last. New fields: `actions` (method, receiver, token amount, deposit and gas of each action), `nativeOutflow` (every Transfer plus every function-call deposit) and `tokenOutflows` (token units per token and recipient). `to` / `amount` / `token` / `memo` are still set when the transaction has one destination of value (a NEAR transfer, one `ft_transfer` with or without `storage_deposit`); a batch that pays several recipients, or mixes a Transfer with a token transfer, leaves `amount` / `token` unset and `to` at the receiver, so read the new fields. New warnings: `batch` (lists every action) and `deposit` (a function call attaching more than 1 yoctoNEAR to a method other than `storage_deposit`). Warnings stay informational; nothing new is refused.
