---
"@anywalletkit/kit": minor
---

NEAR write intents now say when a transaction changes the account itself. `WriteIntent.accountChanges` (new type `NearAccountChange`) lists `add-key` (plus `full-access-key` when the key can do anything), `delete-key`, `deploy-contract`, `stake`, `create-account`, `delete-account`, `delegate` and `global-contract`, read off the actions of `sendTransaction`, `signTransaction` and `signBuilt`, in object and base64 borsh form. Before, such a transaction to the own account reached `confirm` looking like a transfer to self. With a key, code, stake, account-creation or global-contract change, `destinationUnknown` is now true: an allowlist refuses the write even when it names the own account, and a blocklist refuses it without a `confirm` hook. `delete-account` and `delegate` stay judged by the beneficiary and receivers they name. Confirm screens should show `accountChanges` prominently when it is present; plain transfers and token calls are unchanged.
