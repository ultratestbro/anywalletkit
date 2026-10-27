---
"@anywalletkit/wallet-solana": patch
"@anywalletkit/wallet-zcash": minor
"@anywalletkit/kit": patch
---

Solana: `decodeStakeInstruction` no longer guesses an `AuthorizeChecked`, `AuthorizeCheckedWithSeed` or `InitializeChecked` layout when the account that decides it (the Clock or Rent sysvar slot) is unresolved, e.g. loaded from an address lookup table: the new authority (or staker / withdrawer) is left undefined, so the stake guard refuses (`sets-authority`) instead of reading the wallet's own slot as the new authority; the kit marks such an instruction `destinationUnknown`. Zcash: `decodeAddress` refuses an address carrying whitespace or an invisible character (U+FEFF, NBSP…) instead of trimming it, and the kit compares Zcash addresses exactly (base58 is case-sensitive) and marks a recipient that is not plain base58 `destinationUnknown`.
