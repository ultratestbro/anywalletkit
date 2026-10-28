---
"@anywalletkit/protocol-swap2-jupiter": patch
---

`/build`'s setup, cleanup and other instructions are decoded and must each be an exact shape a swap needs: `CreateIdempotent` of the taker's own token account paid by the taker, one System `Transfer` of exactly the input into the taker's wSOL account (SOL source only), `SyncNative` on that account, `CloseAccount` of it back to the taker, `InitializeAccount3` for the taker. Any other System, Token, Token-2022 or Associated Token instruction, and any Jupiter instruction besides the decoded swap, refuses the quote. Before, such instructions passed on their program and signer alone, and a System transfer of a few hundredths of a SOL to a third party or a `TransferChecked` out of the destination account fit inside the balance proof's slack.
