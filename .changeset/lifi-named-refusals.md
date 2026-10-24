---
"@anywalletkit/protocol-swap2-lifi": patch
---

Every refusal after LI.FI answers now names the check that failed. Matrix v7 found 4 silent nulls.

A bridge that takes its fee from the input (glacis: `estimate.fromAmount` about 0.25 % under the spent amount) is now quoted instead of refused:

- **Limits:** the transaction must spend exactly the input, and the input-side fee may be at most 3 %.
- **Amounts:** `sourceAmount` is the spent input, and `destAmount` already reflects the fee.
