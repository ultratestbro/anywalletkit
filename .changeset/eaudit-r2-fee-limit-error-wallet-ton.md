---
"@anywalletkit/wallet-ton": patch
---

The fee-cap refusal (the account's configured maximum or the call's `maxFee`) is now a typed `FeeLimitExceededError` with `code: 'fee-limit-exceeded'`, the `fee` the transaction would pay and the `limit` it is above. The message is unchanged and the error is still thrown before anything is broadcast or returned, so a wallet can show the new fee and ask the user again instead of matching the message text.
